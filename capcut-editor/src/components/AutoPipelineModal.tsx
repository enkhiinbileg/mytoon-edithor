import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AutoPipelineJobSummary,
  AutoPipelinePreflightResult,
  AutoPipelineProgress,
  AutoPipelineResult,
  AutoPipelineSpec,
  ElevenKeyItem,
  Voice,
  VoiceProvider
} from '../types';
import {
  estimateExportSizeBytes,
  formatSecondsHms,
  parseHmsToSeconds,
  type BitrateOption,
  type BitrateType,
  type ResolutionOption
} from '../utils/exportEstimate';
import { clearTagsFromScript } from '../utils/autoTag';

type TtsModel = VoiceProvider['models'][number];

interface SrtSentenceCue {
  id: number;
  start: number;
  end: number;
  duration: number;
  text: string;
}

interface SrtSlicePreviewState {
  totalOriginal: number;
  slicedCount: number;
  sentencesCount: number;
  startSec: number;
  endSec: number | null;
  totalDuration: number;
  firstCue?: SrtSentenceCue;
  lastCue?: SrtSentenceCue;
  error?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onOpenProject?: (projectId?: string | null, projectPath?: string | null) => Promise<void>;
  onSuccessNotice?: (msg: string) => void;
}

interface BatchItem {
  id: string;
  outputName: string;
  scriptText: string;
  videoPath: string;
  videoName: string;
  videoDuration: number;
  srtPath: string;
  srtName: string;
  srtEntriesCount: number;
  srtStartTime: string;
  srtEndTime: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  jobId?: string;
  outPath?: string;
  savedProjectId?: string | null;
  savedProjectPath?: string | null;
  error?: string;
}

const DEFAULT_VOICE_ID = 'TX3LPaxmHKxFdv7VOQHJ';

const STEPS: { key: 'voice' | 'whisper' | 'fix' | 'autocut' | 'export'; title: string; subtitle: string; icon: string }[] = [
  { key: 'voice', title: '1. ElevenLabs Voice', subtitle: 'Скриптээс дуу хоолой үүсгэх', icon: '🎙️' },
  { key: 'whisper', title: '2. Whisper Хадмал', subtitle: 'Groq Large v3 · 2 мөр хадмал', icon: '⚡' },
  { key: 'fix', title: '3. Скриптээр засах', subtitle: 'Хадмалын үг үсгийг тулгах', icon: '📝' },
  { key: 'autocut', title: '4. SRT Auto-Sync & Cut', subtitle: 'Эх видеог өгүүлбэрээр эвлүүлэх', icon: '🎬' },
  { key: 'export', title: '5. Цэвэрлэж Экспортлох', subtitle: 'Түр хадмал устгах + Авто Export', icon: '🚀' }
];

function formatDur(sec?: number): string {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

function splitSecondsToHms(totalSec: number): { h: number; m: number; s: number } {
  const clamped = Math.max(0, Math.floor(totalSec));
  return {
    h: Math.floor(clamped / 3600),
    m: Math.floor((clamped % 3600) / 60),
    s: clamped % 60
  };
}

function findCueNear(cues: SrtSentenceCue[], targetSec: number, preferEnd = false): SrtSentenceCue | null {
  if (!cues.length) return null;
  if (preferEnd) {
    for (let i = cues.length - 1; i >= 0; i--) {
      if (cues[i].start <= targetSec) return cues[i];
    }
    return cues[0];
  }
  return cues.find((c) => c.end >= targetSec) || cues[cues.length - 1];
}

interface SrtBoundPickerProps {
  title: string;
  accent: string;
  valueStr: string;
  maxDuration: number;
  minSec?: number;
  emptyDefaultSec: number;
  resetLabel: string;
  cues: SrtSentenceCue[];
  preferEndCue?: boolean;
  disabled?: boolean;
  extraButton?: { label: string; onClick: () => void };
  onChange: (nextVal: string) => void;
}

function SrtBoundPicker({
  title,
  accent,
  valueStr,
  maxDuration,
  minSec = 0,
  emptyDefaultSec,
  resetLabel,
  cues,
  preferEndCue = false,
  disabled = false,
  extraButton,
  onChange
}: SrtBoundPickerProps) {
  const parsed = parseHmsToSeconds(valueStr);
  const maxBound = Math.max(1, Math.ceil(maxDuration || 3600));
  const currentSec = Math.max(minSec, Math.min(maxBound, parsed ?? emptyDefaultSec));
  const { h, m, s } = splitSecondsToHms(currentSec);
  const cueAtCursor = findCueNear(cues, currentSec, preferEndCue);

  const updateFromHms = (nextH: number, nextM: number, nextS: number) => {
    const clampedH = Math.max(0, Math.min(99, Number.isFinite(nextH) ? Math.floor(nextH) : 0));
    const clampedM = Math.max(0, Math.min(59, Number.isFinite(nextM) ? Math.floor(nextM) : 0));
    const clampedS = Math.max(0, Math.min(59, Number.isFinite(nextS) ? Math.floor(nextS) : 0));
    const total = Math.max(minSec, Math.min(maxBound, clampedH * 3600 + clampedM * 60 + clampedS));
    onChange(formatSecondsHms(total));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    const sec = parseHmsToSeconds(pasted);
    if (sec !== null) {
      e.preventDefault();
      onChange(formatSecondsHms(Math.max(minSec, Math.min(maxBound, sec))));
    }
  };

  return (
    <div
      style={{
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        boxSizing: 'border-box',
        background: '#0b0f1a',
        border: `1px solid ${accent}44`,
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#f8fafc', whiteSpace: 'nowrap' }}>
          {title}: <code style={{ color: accent, fontSize: 12.5 }}>{valueStr.trim() ? formatSecondsHms(currentSec) : resetLabel}</code>
        </span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {extraButton && (
            <button
              type="button"
              onClick={extraButton.onClick}
              disabled={disabled}
              style={{
                padding: '3px 8px',
                borderRadius: 5,
                border: '1px solid rgba(16,185,129,0.4)',
                background: 'rgba(16,185,129,0.16)',
                color: '#6ee7b7',
                fontSize: 10.5,
                fontWeight: 700,
                whiteSpace: 'nowrap',
                cursor: 'pointer'
              }}
            >
              {extraButton.label}
            </button>
          )}
          {valueStr.trim() && (
            <button
              type="button"
              onClick={() => onChange('')}
              disabled={disabled}
              style={{
                padding: '3px 8px',
                borderRadius: 5,
                border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(255,255,255,0.06)',
                color: '#cbd5e1',
                fontSize: 10.5,
                whiteSpace: 'nowrap',
                cursor: 'pointer'
              }}
            >
              {resetLabel}
            </button>
          )}
        </div>
      </div>

      {/* Drag Slider across SRT timeline */}
      {maxDuration > 0 && (
        <input
          type="range"
          min={minSec}
          max={maxBound}
          step={1}
          value={currentSec}
          disabled={disabled}
          onChange={(e) => onChange(formatSecondsHms(Number(e.target.value)))}
          style={{ width: '100%', accentColor: accent, cursor: 'pointer' }}
        />
      )}

      {/* Clean HH : MM : SS Boxes (supports paste of HH:MM:SS) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#94a3b8' }}>
          <input
            type="number"
            min={0}
            max={99}
            value={h}
            disabled={disabled}
            onPaste={handlePaste}
            onChange={(e) => updateFromHms(Number(e.target.value), m, s)}
            title="Цаг (эсвэл 01:25:10 гэх мэт цаг хуулж тавина)"
            style={{
              width: 52,
              padding: '5px 6px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.15)',
              background: '#141a2b',
              color: '#fff',
              textAlign: 'center',
              fontFamily: 'monospace',
              fontSize: 13,
              fontWeight: 700
            }}
          />
          <span>ц</span>
        </label>
        <span style={{ color: '#64748b', fontWeight: 700 }}>:</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#94a3b8' }}>
          <input
            type="number"
            min={0}
            max={59}
            value={m}
            disabled={disabled}
            onPaste={handlePaste}
            onChange={(e) => updateFromHms(h, Number(e.target.value), s)}
            title="Минут (0–59)"
            style={{
              width: 52,
              padding: '5px 6px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.15)',
              background: '#141a2b',
              color: '#fff',
              textAlign: 'center',
              fontFamily: 'monospace',
              fontSize: 13,
              fontWeight: 700
            }}
          />
          <span>м</span>
        </label>
        <span style={{ color: '#64748b', fontWeight: 700 }}>:</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#94a3b8' }}>
          <input
            type="number"
            min={0}
            max={59}
            value={s}
            disabled={disabled}
            onPaste={handlePaste}
            onChange={(e) => updateFromHms(h, m, Number(e.target.value))}
            title="Секунд (0–59)"
            style={{
              width: 52,
              padding: '5px 6px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.15)',
              background: '#141a2b',
              color: '#fff',
              textAlign: 'center',
              fontFamily: 'monospace',
              fontSize: 13,
              fontWeight: 700
            }}
          />
          <span>с</span>
        </label>
      </div>

      {cueAtCursor && (
        <div
          style={{
            minWidth: 0,
            maxWidth: '100%',
            fontSize: 11,
            color: '#93c5fd',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
          title={cueAtCursor.text}
        >
          💬 [{formatSecondsHms(cueAtCursor.start)}]: {cueAtCursor.text}
        </div>
      )}
    </div>
  );
}

export default function AutoPipelineModal({ isOpen, onClose, onOpenProject, onSuccessNotice }: Props) {
  const [activeTab, setActiveTab] = useState<'single' | 'batch' | 'history'>('single');

  // Primary 3 inputs
  const [scriptText, setScriptText] = useState('');
  const [videoInfo, setVideoInfo] = useState<{
    path: string;
    name: string;
    duration: number;
    width: number;
    height: number;
    fps: number;
    detectedSrtStart: string;
  } | null>(null);
  const [srtInfo, setSrtInfo] = useState<{
    path: string;
    name: string;
    entriesCount: number;
  } | null>(null);
  const [srtStartTime, setSrtStartTime] = useState('');
  const [srtEndTime, setSrtEndTime] = useState('');
  const [fullSrtCues, setFullSrtCues] = useState<SrtSentenceCue[]>([]);
  const [fullSrtDuration, setFullSrtDuration] = useState<number>(0);
  const [srtPreview, setSrtPreview] = useState<SrtSlicePreviewState | null>(null);
  const [srtCuePickerOpen, setSrtCuePickerOpen] = useState(false);
  const [srtCueSearch, setSrtCueSearch] = useState('');
  const [outputName, setOutputName] = useState('');

  // API Keys & Pool state (ElevenLabs + Groq + Gemini readiness)
  const [keyPool, setKeyPool] = useState<ElevenKeyItem[]>([]);
  const [poolDrawerOpen, setPoolDrawerOpen] = useState(false);
  const [newKeyInput, setNewKeyInput] = useState('');
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [addingKey, setAddingKey] = useState(false);
  const [refreshingPool, setRefreshingPool] = useState(false);
  const [keyPoolError, setKeyPoolError] = useState('');
  const [hasGroqKey, setHasGroqKey] = useState(false);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);

  // Persisted pipeline settings (Defaults strictly match user's choices)
  const [voices, setVoices] = useState<Voice[]>([]);
  const [ttsModels, setTtsModels] = useState<TtsModel[]>([]);
  const [whisperModels, setWhisperModels] = useState<{ id: string; label: string; installed: boolean }[]>([]);
  const [detectedEncoders, setDetectedEncoders] = useState<{ h264?: string; hevc?: string; av1?: string }>({});

  const [voiceId, setVoiceId] = useState(DEFAULT_VOICE_ID);
  const [elevenModelId, setElevenModelId] = useState('eleven_v4');
  const [speed, setSpeed] = useState(1.0);
  const [stability, setStability] = useState(0.5);
  const [similarity, setSimilarity] = useState(0.75);
  const [autoTagScript, setAutoTagScript] = useState(false);
  const [tagIntensity, setTagIntensity] = useState<'balanced' | 'dramatic'>('balanced');
  const [whisperModel, setWhisperModel] = useState('groq-whisper-large-v3');
  const [compactCaptions, setCompactCaptions] = useState(true);
  const [geminiModel, setGeminiModel] = useState('gemini-3.6-flash');
  const [resolution, setResolution] = useState<ResolutionOption>('1080P');
  const [aspect, setAspect] = useState<'auto' | '16:9' | '9:16'>('auto');
  const [fps, setFps] = useState(30);
  const [codec, setCodec] = useState<'hevc' | 'h264' | 'av1'>('hevc');
  const [bitrateOption, setBitrateOption] = useState<BitrateOption>('custom');
  const [customBitrate, setCustomBitrate] = useState<number>(1000);
  const [bitrateType, setBitrateType] = useState<BitrateType>('vbr');
  const [quality, setQuality] = useState<'draft' | 'standard' | 'high'>('standard');
  const [format, setFormat] = useState<'mp4' | 'mov'>('mp4');
  const [audioBitrate, setAudioBitrate] = useState<'128k' | '192k' | '320k'>('192k');
  const [exportDir, setExportDir] = useState('');
  const [saveProjectToLibrary, setSaveProjectToLibrary] = useState(true);
  const [openProjectAfterExport, setOpenProjectAfterExport] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Runtime state
  const [preflight, setPreflight] = useState<AutoPipelinePreflightResult | null>(null);
  const [checkingPreflight, setCheckingPreflight] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<AutoPipelineProgress | null>(null);
  const [liveVoiceDuration, setLiveVoiceDuration] = useState<number | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<AutoPipelineResult | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  // Batch & History
  const [batchQueue, setBatchQueue] = useState<BatchItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const batchAbortRef = useRef(false);
  const [jobHistory, setJobHistory] = useState<AutoPipelineJobSummary[]>([]);
  const settingsLoadedRef = useRef(false);

  const detectedTagCount = useMemo(() => (scriptText.match(/\[[a-zA-Z\s]{2,25}\]/g) || []).length, [scriptText]);

  const poolSummary = useMemo(() => {
    const seenUsers = new Set<string>();
    let totalRemaining = 0;
    let activeCount = 0;
    let duplicates = 0;
    for (const k of keyPool) {
      if (!k.enabled || k.status === 'blocked' || k.status === 'error') continue;
      activeCount++;
      const uid = k.quota?.userId;
      const rem = typeof k.quota?.remaining === 'number' ? k.quota.remaining : 10000;
      if (uid) {
        if (seenUsers.has(uid)) {
          duplicates++;
          continue;
        }
        seenUsers.add(uid);
      }
      totalRemaining += rem;
    }
    return { activeCount, totalRemaining, duplicates };
  }, [keyPool]);

  const durationEstimate = useMemo(() => {
    if (result?.report?.exportDuration && result.report.exportDuration > 0) {
      return { sec: result.report.exportDuration, source: 'Бодит экспорт' };
    }
    if (liveVoiceDuration && liveVoiceDuration > 0) {
      return { sec: liveVoiceDuration, source: 'Үүссэн дуу' };
    }
    const cleanLen = clearTagsFromScript(scriptText).text.trim().length;
    if (cleanLen > 0) {
      const est = Math.max(1, cleanLen / (13.5 * Math.max(0.5, speed || 1)));
      return { sec: est, source: `Скрипт (~${formatSecondsHms(est)} орчим)` };
    }
    if (srtPreview?.totalDuration && srtPreview.totalDuration > 0) {
      return { sec: srtPreview.totalDuration, source: 'SRT урт' };
    }
    if (videoInfo?.duration && videoInfo.duration > 0) {
      return { sec: videoInfo.duration, source: 'Эх видео урт' };
    }
    return { sec: 0, source: 'Оролт дутуу' };
  }, [result, liveVoiceDuration, scriptText, speed, srtPreview, videoInfo]);

  const exportEstimate = useMemo(() => {
    return estimateExportSizeBytes({
      exportVideo: true,
      exportAudio: true,
      bitrateOption,
      customBitrate,
      resolution,
      fps,
      audioBitrate,
      durationSec: durationEstimate.sec
    });
  }, [bitrateOption, customBitrate, resolution, fps, audioBitrate, durationEstimate.sec]);

  const loadHistory = async () => {
    try {
      const res = await window.api.listAutoPipelineJobs?.();
      if (res?.ok) setJobHistory(res.jobs || []);
    } catch {}
  };

  const refreshPoolAndKeys = async () => {
    try {
      const [s, poolRes] = await Promise.all([
        window.api.readSettings?.().catch(() => null),
        window.api.getElevenKeyPool?.().catch(() => null)
      ]);
      if (Array.isArray(poolRes)) setKeyPool(poolRes);
      else if (Array.isArray((s as any)?.elevenLabsKeyPool)) setKeyPool((s as any).elevenLabsKeyPool);
      setHasGroqKey(Boolean((s as any)?.groqApiKey));
      setHasGeminiKey(Boolean((s as any)?.geminiApiKey));
    } catch {}
  };

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;

    Promise.all([
      window.api.readSettings?.().catch(() => null),
      window.api.getElevenKeyPool?.().catch(() => null),
      window.api.listVoices?.('elevenlabs').catch(() => []),
      window.api.listTtsModels?.('elevenlabs').catch(() => []),
      window.api.whisperStatus?.().catch(() => null),
      window.api.detectEncoders?.().catch(() => null),
      window.api.getDefaultExportDir?.().catch(() => '')
    ]).then(([s, poolList, vList, mList, wStat, enc, defDir]) => {
      if (!alive) return;
      if (Array.isArray(poolList)) setKeyPool(poolList);
      else if (Array.isArray((s as any)?.elevenLabsKeyPool)) setKeyPool((s as any).elevenLabsKeyPool);
      setHasGroqKey(Boolean((s as any)?.groqApiKey));
      setHasGeminiKey(Boolean((s as any)?.geminiApiKey));
      if (vList && 'ok' in vList && vList.ok && Array.isArray(vList.voices) && vList.voices.length) setVoices(vList.voices);
      if (mList && 'ok' in mList && mList.ok && Array.isArray(mList.models) && mList.models.length) setTtsModels(mList.models);
      if (wStat?.models) setWhisperModels(wStat.models);
      if (enc) setDetectedEncoders(enc);

      const saved = (s as any)?.autoPipeline;
      if (saved && typeof saved === 'object') {
        if (saved.voiceId) setVoiceId(saved.voiceId);
        if (saved.elevenModelId) setElevenModelId(saved.elevenModelId);
        if (typeof saved.speed === 'number') setSpeed(saved.speed);
        if (typeof saved.stability === 'number') setStability(saved.stability);
        if (typeof saved.similarity === 'number') setSimilarity(saved.similarity);
        if (typeof saved.autoTagScript === 'boolean') setAutoTagScript(saved.autoTagScript);
        if (saved.tagIntensity) setTagIntensity(saved.tagIntensity);
        if (saved.whisperModel) setWhisperModel(saved.whisperModel);
        if (typeof saved.compactCaptions === 'boolean') setCompactCaptions(saved.compactCaptions);
        if (saved.geminiModel) setGeminiModel(saved.geminiModel);
        if (saved.resolution) setResolution(saved.resolution);
        if (saved.aspect) setAspect(saved.aspect);
        if (typeof saved.fps === 'number') setFps(saved.fps);
        if (saved.codec) setCodec(saved.codec);
        if (saved.bitrateOption) setBitrateOption(saved.bitrateOption);
        if (typeof saved.customBitrate === 'number') setCustomBitrate(saved.customBitrate);
        if (saved.bitrateType === 'cbr' || saved.bitrateType === 'vbr') setBitrateType(saved.bitrateType);
        if (saved.quality) setQuality(saved.quality);
        if (saved.format) setFormat(saved.format);
        if (saved.audioBitrate) setAudioBitrate(saved.audioBitrate);
        if (saved.exportDir) setExportDir(saved.exportDir);
        if (typeof saved.saveProjectToLibrary === 'boolean') setSaveProjectToLibrary(saved.saveProjectToLibrary);
        if (typeof saved.openProjectAfterExport === 'boolean') setOpenProjectAfterExport(saved.openProjectAfterExport);
      } else if (defDir) {
        const sep = defDir.includes('\\') ? '\\' : '/';
        setExportDir(`${defDir.replace(/[\\/]+$/, '')}${sep}Cutline Exports`);
      }
      settingsLoadedRef.current = true;
    });

    loadHistory();
    return () => { alive = false; };
  }, [isOpen]);

  // Persist user preferences cleanly in settings.json
  useEffect(() => {
    if (!isOpen || !settingsLoadedRef.current) return;
    const t = setTimeout(() => {
      window.api.updateSettings?.({
        autoPipeline: {
          voiceId,
          elevenModelId,
          speed,
          stability,
          similarity,
          autoTagScript,
          tagIntensity,
          whisperModel,
          compactCaptions,
          geminiModel,
          resolution,
          aspect,
          fps,
          codec,
          bitrateOption,
          customBitrate,
          bitrateType,
          quality,
          format,
          audioBitrate,
          exportDir,
          saveProjectToLibrary,
          openProjectAfterExport
        }
      }).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [
    isOpen, voiceId, elevenModelId, speed, stability, similarity, autoTagScript, tagIntensity,
    whisperModel, compactCaptions, geminiModel, resolution, aspect, fps, codec,
    bitrateOption, customBitrate, bitrateType, quality,
    format, audioBitrate, exportDir, saveProjectToLibrary, openProjectAfterExport
  ]);

  // Live SRT slice preview when SRT file or start/end time changes
  useEffect(() => {
    if (!isOpen || !srtInfo?.path) {
      setSrtPreview(null);
      return;
    }
    let active = true;
    const t = setTimeout(() => {
      window.api.sliceSrtPreview?.({
        srtPath: srtInfo.path,
        srtStartTime: srtStartTime.trim() || 0,
        srtEndTime: srtEndTime.trim() || undefined
      }).then((res) => {
        if (!active) return;
        if (res?.ok) {
          const cues: SrtSentenceCue[] = Array.isArray(res.sentences) ? res.sentences : [];
          setSrtPreview({
            totalOriginal: res.totalOriginal || srtInfo.entriesCount,
            slicedCount: res.slicedCount || 0,
            sentencesCount: res.sentencesCount || cues.length,
            startSec: res.startSec || 0,
            endSec: res.endSec ?? null,
            totalDuration: res.totalDuration || 0,
            firstCue: cues[0],
            lastCue: cues[cues.length - 1]
          });
        } else if (res?.error) {
          setSrtPreview({
            totalOriginal: srtInfo.entriesCount,
            slicedCount: 0,
            sentencesCount: 0,
            startSec: 0,
            endSec: null,
            totalDuration: 0,
            error: res.error
          });
        }
      }).catch(() => {});
    }, 220);
    return () => { active = false; clearTimeout(t); };
  }, [isOpen, srtInfo, srtStartTime, srtEndTime]);

  useEffect(() => {
    if (!isOpen) return;
    const unsub = window.api.onAutoPipelineProgress?.((p) => {
      setProgress(p);
      if (p.jobId) setActiveJobId(p.jobId);
      if (typeof p.voiceDuration === 'number' && p.voiceDuration > 0) {
        setLiveVoiceDuration(p.voiceDuration);
      }
      if (p.message) {
        setLogs((prev) => {
          if (prev.length && prev[prev.length - 1] === p.message) return prev;
          return [...prev.slice(-39), p.message];
        });
      }
    });
    return () => { unsub?.(); };
  }, [isOpen]);

  if (!isOpen) return null;

  const buildSpec = (overrides?: Partial<AutoPipelineSpec>): AutoPipelineSpec => {
    const mode = bitrateOption === 'custom' ? bitrateType : bitrateOption;
    const derivedQuality =
      bitrateOption === 'higher' ? 'high' : bitrateOption === 'lower' ? 'draft' : quality;
    return {
      scriptText,
      videoPath: videoInfo?.path || '',
      srtPath: srtInfo?.path || '',
      srtStartTime: srtStartTime.trim() || undefined,
      srtEndTime: srtEndTime.trim() || undefined,
      voiceId,
      elevenModelId,
      stability,
      similarity,
      speed,
      autoTagScript,
      tagIntensity,
      whisperModel,
      compactCaptions,
      geminiModel,
      saveProjectToLibrary,
      openProjectAfterExport,
      exportDir: exportDir.trim() || undefined,
      outputName: outputName.trim() || undefined,
      exportOptions: {
        resolution,
        aspect,
        fps,
        codec,
        quality: derivedQuality,
        bitrateOption,
        bitrateType,
        bitrateMode: mode,
        customBitrate: bitrateOption === 'custom' ? customBitrate : undefined,
        format,
        audioBitrate
      },
      ...overrides
    };
  };

  const handleAddPoolKey = async () => {
    if (!newKeyInput.trim() || addingKey) return;
    setAddingKey(true);
    setKeyPoolError('');
    try {
      const res = await window.api.addElevenKey?.(newKeyInput.trim(), newKeyLabel.trim() || undefined);
      if (res?.ok && res.pool) {
        setKeyPool(res.pool);
        setNewKeyInput('');
        setNewKeyLabel('');
        // Refresh voices cleanly once key is added
        const vRes = await window.api.listVoices?.('elevenlabs').catch(() => null);
        if (vRes && 'ok' in vRes && vRes.ok && Array.isArray(vRes.voices) && vRes.voices.length) {
          setVoices(vRes.voices);
        }
      } else {
        setKeyPoolError(res?.error || 'Түлхүүр нэмэхэд алдаа гарлаа.');
      }
    } catch (err: any) {
      setKeyPoolError(String(err?.message || err));
    } finally {
      setAddingKey(false);
    }
  };

  const handleRemovePoolKey = async (keyId: string) => {
    try {
      const res = await window.api.removeElevenKey?.(keyId);
      if (res?.ok && res.pool) setKeyPool(res.pool);
    } catch {}
  };

  const handleTogglePoolKey = async (keyId: string, enabled: boolean) => {
    try {
      const res = await window.api.toggleElevenKey?.(keyId, enabled);
      if (res?.ok && res.pool) setKeyPool(res.pool);
    } catch {}
  };

  const handleRefreshPoolQuotas = async () => {
    if (refreshingPool) return;
    setRefreshingPool(true);
    setKeyPoolError('');
    try {
      const res = await window.api.refreshElevenQuotas?.();
      if (res?.ok && res.pool) setKeyPool(res.pool);
      await refreshPoolAndKeys();
    } catch (err: any) {
      setKeyPoolError(String(err?.message || err));
    } finally {
      setRefreshingPool(false);
    }
  };

  const handleMatchEndToVideoDuration = () => {
    if (!videoInfo?.duration) return;
    const startSec = parseHmsToSeconds(srtStartTime) ?? 0;
    const maxBound = fullSrtDuration > 0 ? Math.ceil(fullSrtDuration) : 86400;
    const targetEnd = Math.min(maxBound, Math.round(startSec + videoInfo.duration));
    setSrtEndTime(formatSecondsHms(targetEnd));
    setPreflight(null);
  };

  const handleLoadTxt = async () => {
    const res = await window.api.openTxtFile?.();
    if (res?.ok && res.text) {
      setScriptText(res.text);
      setPreflight(null);
    }
  };

  const handlePickVideo = async () => {
    const res = await window.api.openVideoFile?.();
    if (res?.ok && res.path) {
      const detected = res.detectedSrtStart || '';
      setVideoInfo({
        path: res.path,
        name: res.name || 'video.mp4',
        duration: res.duration || 0,
        width: res.width || 1920,
        height: res.height || 1080,
        fps: res.fps || 30,
        detectedSrtStart: detected
      });
      if (detected && !srtStartTime.trim()) {
        setSrtStartTime(detected);
      }
      if (!outputName.trim() && res.name) {
        setOutputName(`${res.name.replace(/\.[^.]+$/, '')}_auto`);
      }
      setPreflight(null);
    } else if (res && !res.ok && res.error) {
      setLogs((prev) => [...prev, `⚠️ ${res.error}`]);
    }
  };

  const handlePickSrt = async () => {
    const res = await window.api.openSrtFile?.();
    if (res?.ok && res.path) {
      setSrtInfo({
        path: res.path,
        name: res.name || 'subtitles.srt',
        entriesCount: res.entriesCount || 0
      });
      setPreflight(null);
      setSrtCuePickerOpen(false);
      // Load full un-sliced cues for instant duration & timestamp picker
      try {
        const fullRes = await window.api.sliceSrtPreview?.({ srtPath: res.path, srtStartTime: 0 });
        if (fullRes?.ok && Array.isArray(fullRes.sentences)) {
          setFullSrtCues(fullRes.sentences);
          setFullSrtDuration(fullRes.totalDuration || 0);
        }
      } catch {}
    }
  };

  const handlePickExportFolder = async () => {
    const folder = await window.api.selectExportFolder?.(exportDir || undefined);
    if (folder) setExportDir(folder);
  };

  const handlePreflight = async () => {
    setCheckingPreflight(true);
    setPreflight(null);
    try {
      const res = await window.api.preflightAutoPipeline(buildSpec());
      setPreflight(res);
      return res;
    } finally {
      setCheckingPreflight(false);
    }
  };

  const handleStartSingle = async () => {
    if (running || batchRunning) return;
    setResult(null);
    setLogs([]);
    setProgress(null);
    setLiveVoiceDuration(null);

    setCheckingPreflight(true);
    const pf = await window.api.preflightAutoPipeline(buildSpec());
    setPreflight(pf);
    setCheckingPreflight(false);
    if (!pf.ok) return;

    setRunning(true);
    try {
      const res = await window.api.runAutoPipeline(buildSpec());
      setResult(res);
      if (res.jobId) setActiveJobId(res.jobId);
      await Promise.all([loadHistory(), refreshPoolAndKeys()]);
      if (res.ok) {
        onSuccessNotice?.(`✨ Авто эвлүүлэг ба экспорт бэлэн: ${res.outPath}`);
        if (openProjectAfterExport && onOpenProject && (res.savedProjectId || res.savedProjectPath)) {
          await onOpenProject(res.savedProjectId, res.savedProjectPath);
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const handleResumeJob = async (jobIdToResume: string) => {
    if (running || batchRunning) return;
    setResult(null);
    setRunning(true);
    setActiveJobId(jobIdToResume);
    try {
      const res = await window.api.resumeAutoPipeline(jobIdToResume);
      setResult(res);
      await Promise.all([loadHistory(), refreshPoolAndKeys()]);
      if (res.ok) {
        onSuccessNotice?.(`✨ Сэргээж дуусгав: ${res.outPath}`);
        if (openProjectAfterExport && onOpenProject && (res.savedProjectId || res.savedProjectPath)) {
          await onOpenProject(res.savedProjectId, res.savedProjectPath);
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const handleCancel = async () => {
    batchAbortRef.current = true;
    await window.api.cancelAutoPipeline?.();
  };

  const handleAddCurrentToBatch = () => {
    if (!scriptText.trim() || !videoInfo?.path || !srtInfo?.path) return;
    const item: BatchItem = {
      id: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      outputName: outputName.trim() || `${videoInfo.name.replace(/\.[^.]+$/, '')}_auto`,
      scriptText: scriptText.trim(),
      videoPath: videoInfo.path,
      videoName: videoInfo.name,
      videoDuration: videoInfo.duration,
      srtPath: srtInfo.path,
      srtName: srtInfo.name,
      srtEntriesCount: srtInfo.entriesCount,
      srtStartTime: srtStartTime.trim(),
      srtEndTime: srtEndTime.trim(),
      status: 'queued'
    };
    setBatchQueue((prev) => [...prev, item]);
    setActiveTab('batch');
  };

  const handleRunBatch = async () => {
    if (running || batchRunning || batchQueue.length === 0) return;
    batchAbortRef.current = false;
    setBatchRunning(true);
    try {
      for (let i = 0; i < batchQueue.length; i++) {
        if (batchAbortRef.current) break;
        const item = batchQueue[i];
        if (item.status === 'completed') continue;

        setBatchQueue((prev) => prev.map((it) => (it.id === item.id ? { ...it, status: 'running', error: undefined } : it)));
        const itemSpec = buildSpec({
          scriptText: item.scriptText,
          videoPath: item.videoPath,
          srtPath: item.srtPath,
          srtStartTime: item.srtStartTime || undefined,
          srtEndTime: item.srtEndTime || undefined,
          outputName: item.outputName,
          openProjectAfterExport: false
        });

        const res = item.jobId
          ? await window.api.resumeAutoPipeline(item.jobId, itemSpec)
          : await window.api.runAutoPipeline(itemSpec);

        setBatchQueue((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  status: res.ok ? 'completed' : res.canceled ? 'canceled' : 'failed',
                  jobId: res.jobId || it.jobId,
                  outPath: res.outPath,
                  savedProjectId: res.savedProjectId,
                  savedProjectPath: res.savedProjectPath,
                  error: res.error
                }
              : it
          )
        );
        if (res.canceled) break;
      }
      await loadHistory();
    } finally {
      setBatchRunning(false);
    }
  };

  const activeEncoderLabel = detectedEncoders[codec] || (codec === 'hevc' ? 'auto/libx265' : codec);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Бүрэн Авто Видео Үйлдвэр"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(6, 9, 19, 0.82)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 18
      }}
    >
      <div
        style={{
          width: 'min(1040px, 95vw)',
          maxWidth: '95vw',
          maxHeight: '92vh',
          margin: '0 auto',
          background: '#111625',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          color: '#e2e8f0'
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '12px 18px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            background: 'linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(59,130,246,0.12) 100%)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 20, flexShrink: 0 }}>🚀</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                100% Бүрэн Авто Видео (Script + Video + SRT → Final MP4)
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                ElevenLabs Voice → Groq Large v3 (2 мөр) → Скриптээр засах → SRT Auto-Cut → Хадмал устгаж Авто Export
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setActiveTab('single')}
              style={{
                padding: '6px 11px',
                borderRadius: 8,
                fontSize: 11.5,
                fontWeight: 700,
                whiteSpace: 'nowrap',
                border: '1px solid rgba(255,255,255,0.12)',
                background: activeTab === 'single' ? '#10b981' : 'rgba(255,255,255,0.05)',
                color: activeTab === 'single' ? '#042f2e' : '#cbd5e1',
                cursor: 'pointer'
              }}
            >
              ⚡ Нэг анги
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('batch')}
              style={{
                padding: '6px 11px',
                borderRadius: 8,
                fontSize: 11.5,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                border: '1px solid rgba(255,255,255,0.12)',
                background: activeTab === 'batch' ? '#3b82f6' : 'rgba(255,255,255,0.05)',
                color: activeTab === 'batch' ? '#fff' : '#cbd5e1',
                cursor: 'pointer'
              }}
            >
              📚 Багц ({batchQueue.length})
            </button>
            <button
              type="button"
              onClick={() => { setActiveTab('history'); loadHistory(); }}
              style={{
                padding: '6px 11px',
                borderRadius: 8,
                fontSize: 11.5,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                border: '1px solid rgba(255,255,255,0.12)',
                background: activeTab === 'history' ? '#8b5cf6' : 'rgba(255,255,255,0.05)',
                color: activeTab === 'history' ? '#fff' : '#cbd5e1',
                cursor: 'pointer'
              }}
            >
              🕒 Түүх
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={running || batchRunning}
              title={running || batchRunning ? 'Ажил дуусах эсвэл зогсоосны дараа хаана уу' : 'Хаах'}
              style={{
                marginLeft: 4,
                width: 30,
                height: 30,
                flexShrink: 0,
                borderRadius: 8,
                border: 'none',
                background: 'rgba(255,255,255,0.08)',
                color: '#cbd5e1',
                cursor: running || batchRunning ? 'not-allowed' : 'pointer',
                opacity: running || batchRunning ? 0.45 : 1,
                fontSize: 16
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {activeTab === 'single' && (
            <>
              {/* ElevenLabs Key Pool & API Readiness Header Bar */}
              <div
                style={{
                  background: 'rgba(99, 102, 241, 0.08)',
                  border: `1px solid ${poolSummary.activeCount > 0 ? 'rgba(99, 102, 241, 0.35)' : 'rgba(239, 68, 68, 0.45)'}`,
                  borderRadius: 10,
                  padding: '10px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
                    <span style={{ fontWeight: 700, color: '#e0e7ff' }}>🔑 ElevenLabs Түлхүүр:</span>
                    {poolSummary.activeCount > 0 ? (
                      <span style={{ padding: '2px 8px', borderRadius: 999, background: 'rgba(16,185,129,0.18)', color: '#34d399', fontWeight: 700, fontSize: 11.5 }}>
                        {poolSummary.activeCount} идэвхтэй · ~{poolSummary.totalRemaining.toLocaleString()} кредит
                      </span>
                    ) : (
                      <span style={{ padding: '2px 8px', borderRadius: 999, background: 'rgba(239,68,68,0.2)', color: '#fca5a5', fontWeight: 700, fontSize: 11.5 }}>
                        Түлхүүр бүртгэгдээгүй — оруулна уу
                      </span>
                    )}
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 600,
                        background: hasGroqKey ? 'rgba(59,130,246,0.16)' : 'rgba(245,158,11,0.18)',
                        color: hasGroqKey ? '#93c5fd' : '#fcd34d'
                      }}
                    >
                      {hasGroqKey ? '⚡ Groq: Бэлэн' : '⚠️ Groq түлхүүр алга'}
                    </span>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 600,
                        background: hasGeminiKey ? 'rgba(168,85,247,0.18)' : 'rgba(245,158,11,0.18)',
                        color: hasGeminiKey ? '#d8b4fe' : '#fcd34d'
                      }}
                    >
                      {hasGeminiKey ? '✨ Gemini: Бэлэн' : '⚠️ Gemini түлхүүр алга'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      type="button"
                      onClick={handleRefreshPoolQuotas}
                      disabled={refreshingPool || running}
                      style={{
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: 600,
                        borderRadius: 6,
                        border: '1px solid rgba(255,255,255,0.14)',
                        background: 'rgba(255,255,255,0.06)',
                        color: '#e2e8f0',
                        cursor: refreshingPool ? 'wait' : 'pointer'
                      }}
                    >
                      {refreshingPool ? 'Шинэчилж...' : '↻ Кредит шалгах'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPoolDrawerOpen((v) => !v)}
                      style={{
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: 700,
                        borderRadius: 6,
                        border: '1px solid rgba(99,102,241,0.45)',
                        background: poolDrawerOpen ? '#4f46e5' : 'rgba(99,102,241,0.22)',
                        color: '#fff',
                        cursor: 'pointer'
                      }}
                    >
                      {poolDrawerOpen ? '▲ Түлхүүрийн сан хаах' : `▼ Түлхүүр нэмэх / удирдах (${keyPool.length})`}
                    </button>
                  </div>
                </div>

                {poolSummary.duplicates > 0 && (
                  <div style={{ fontSize: 11, color: '#fde047' }}>
                    ⚠️ {poolSummary.duplicates} давхардсан дансны түлхүүр илэрсэн тул нийт кредитийг бодитоор тооцов.
                  </div>
                )}

                {poolDrawerOpen && (
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      background: '#0b0f1a',
                      border: '1px solid rgba(255,255,255,0.08)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8
                    }}
                  >
                    {keyPool.length === 0 ? (
                      <div style={{ fontSize: 11.5, color: '#94a3b8' }}>
                        ElevenLabs API түлхүүр алга байна. Доор шинэ түлхүүрээ нэмнэ үү.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 150, overflowY: 'auto' }}>
                        {keyPool.map((k) => {
                          const rem = k.quota?.remaining;
                          const lim = k.quota?.limit;
                          const hasQ = typeof rem === 'number' && typeof lim === 'number';
                          return (
                            <div
                              key={k.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 8,
                                padding: '6px 10px',
                                borderRadius: 6,
                                background: 'rgba(255,255,255,0.03)',
                                border: '1px solid rgba(255,255,255,0.07)',
                                opacity: k.enabled ? 1 : 0.55
                              }}
                            >
                              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1 }}>
                                <input
                                  type="checkbox"
                                  checked={k.enabled}
                                  disabled={running}
                                  onChange={(e) => handleTogglePoolKey(k.id, e.target.checked)}
                                />
                                <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>{k.label}</span>
                                <code style={{ fontSize: 10.5, color: '#94a3b8' }}>{k.maskedKey}</code>
                                {k.status === 'blocked' || k.status === 'error' ? (
                                  <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.2)', color: '#fca5a5', fontWeight: 700 }}>
                                    ⛔ {k.status === 'blocked' ? 'Хаагдсан / Төлбөр' : 'Алдаатай'}
                                  </span>
                                ) : (
                                  <span style={{ fontSize: 11, color: hasQ && rem! > 0 ? '#34d399' : '#fbbf24' }}>
                                    {hasQ ? `${rem!.toLocaleString()} / ${lim!.toLocaleString()} кредит` : 'Шалгаагүй'}
                                  </span>
                                )}
                              </label>
                              <button
                                type="button"
                                disabled={running}
                                onClick={() => handleRemovePoolKey(k.id)}
                                title="Устгах"
                                style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 12 }}
                              >
                                🗑️
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <input
                        type="text"
                        placeholder="Нэр (ж. Key #1)"
                        value={newKeyLabel}
                        disabled={running}
                        onChange={(e) => setNewKeyLabel(e.target.value)}
                        style={{ width: 130, padding: '6px 8px', borderRadius: 6, background: '#111625', border: '1px solid rgba(255,255,255,0.14)', color: '#fff', fontSize: 11.5 }}
                      />
                      <input
                        type="password"
                        placeholder="ElevenLabs API Key (xi-... эсвэл sk_...)"
                        value={newKeyInput}
                        disabled={running}
                        onChange={(e) => setNewKeyInput(e.target.value)}
                        style={{ flex: 1, minWidth: 200, padding: '6px 10px', borderRadius: 6, background: '#111625', border: '1px solid rgba(255,255,255,0.14)', color: '#fff', fontSize: 11.5 }}
                      />
                      <button
                        type="button"
                        onClick={handleAddPoolKey}
                        disabled={addingKey || running || !newKeyInput.trim()}
                        style={{
                          padding: '6px 12px',
                          borderRadius: 6,
                          border: 'none',
                          background: '#6366f1',
                          color: '#fff',
                          fontSize: 11.5,
                          fontWeight: 700,
                          cursor: addingKey || !newKeyInput.trim() ? 'not-allowed' : 'pointer',
                          opacity: !newKeyInput.trim() ? 0.5 : 1
                        }}
                      >
                        {addingKey ? 'Шалгаж байна...' : '+ Нэмэх'}
                      </button>
                    </div>
                    {keyPoolError && <div style={{ fontSize: 11, color: '#f87171' }}>⚠️ {keyPoolError}</div>}
                  </div>
                )}
              </div>

              {/* Top 3 inputs grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)', gap: 12 }}>
                {/* Left: Script */}
                <div
                  style={{
                    minWidth: 0,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 10,
                    padding: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#f8fafc' }}>
                      1. ElevenLabs Монгол Скрипт
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, color: '#94a3b8' }}>
                        {scriptText.trim().length.toLocaleString()} тэмдэгт · {detectedTagCount} tag
                      </span>
                      <button
                        type="button"
                        onClick={handleLoadTxt}
                        disabled={running}
                        style={{
                          padding: '4px 10px',
                          fontSize: 11.5,
                          fontWeight: 600,
                          borderRadius: 6,
                          border: '1px solid rgba(99,102,241,0.35)',
                          background: 'rgba(99,102,241,0.14)',
                          color: '#c7d2fe',
                          cursor: 'pointer'
                        }}
                      >
                        📄 .TXT оруулах
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={scriptText}
                    onChange={(e) => { setScriptText(e.target.value); setPreflight(null); }}
                    disabled={running}
                    placeholder="ElevenLabs-т уншуулах Монгол зохиолоо энд хуулж тавина уу (хэрэв [whispers], [sighs] зэрэг tag байвал Voice унших үед ашиглаад хадмал засах үед автоматаар цэвэрлэнэ)..."
                    style={{
                      width: '100%',
                      minHeight: 145,
                      resize: 'vertical',
                      background: '#0b0f1a',
                      color: '#f1f5f9',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 8,
                      padding: 10,
                      fontSize: 12.5,
                      lineHeight: 1.5,
                      fontFamily: 'inherit'
                    }}
                  />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#cbd5e1', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={autoTagScript}
                      disabled={running}
                      onChange={(e) => setAutoTagScript(e.target.checked)}
                    />
                    <span>Сэтгэл хөдлөлийн Audio Tag автоматаар нэмэх ({tagIntensity === 'dramatic' ? 'Драм' : 'Тэнцвэртэй'})</span>
                  </label>
                </div>

                {/* Right: Video + Output Name */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                  {/* Source Video Picker */}
                  <div
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 10,
                      padding: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      flex: 1
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: '#f8fafc' }}>2. Эх Видео Файл</span>
                      <button
                        type="button"
                        onClick={handlePickVideo}
                        disabled={running}
                        style={{
                          padding: '5px 11px',
                          fontSize: 11.5,
                          fontWeight: 600,
                          borderRadius: 6,
                          border: '1px solid rgba(16,185,129,0.4)',
                          background: 'rgba(16,185,129,0.14)',
                          color: '#6ee7b7',
                          cursor: 'pointer'
                        }}
                      >
                        🎞️ Видео сонгох
                      </button>
                    </div>
                    {videoInfo ? (
                      <div style={{ fontSize: 11.5, color: '#cbd5e1', lineHeight: 1.55 }}>
                        <div style={{ fontWeight: 600, color: '#fff', wordBreak: 'break-all' }}>{videoInfo.name}</div>
                        <div style={{ color: '#94a3b8' }}>
                          {videoInfo.width}×{videoInfo.height} · {Math.round(videoInfo.fps)}fps · {formatDur(videoInfo.duration)}
                        </div>
                        {videoInfo.detectedSrtStart && (
                          <div style={{ color: '#34d399', marginTop: 4 }}>
                            ✂️ Файлын нэрнээс <b>{videoInfo.detectedSrtStart}</b> огтлолт танилаа
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11.5, color: '#64748b' }}>MP4, MOV, MKV, WEBM эх видео сонгоно уу</div>
                    )}
                  </div>

                  {/* Output Name */}
                  <div
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 10,
                      padding: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6
                    }}
                  >
                    <label style={{ fontSize: 11.5, color: '#94a3b8', fontWeight: 600 }}>Гарах видеоны нэр</label>
                    <input
                      type="text"
                      value={outputName}
                      disabled={running}
                      onChange={(e) => setOutputName(e.target.value)}
                      placeholder="auto_recap_ep1"
                      style={{
                        padding: '7px 10px',
                        borderRadius: 6,
                        border: '1px solid rgba(255,255,255,0.1)',
                        background: '#0b0f1a',
                        color: '#fff',
                        fontSize: 12
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* 3. Full-width English SRT & Visual Start/End Timestamp Card */}
              <div
                style={{
                  minWidth: 0,
                  maxWidth: '100%',
                  overflow: 'hidden',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 10,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: '1 1 280px' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#f8fafc' }}>3. Англи SRT Файл & Хугацааны Хэсэг</span>
                    {srtInfo ? (
                      <span style={{ fontSize: 11.5, color: '#cbd5e1', wordBreak: 'break-word' }}>
                        <b style={{ color: '#fff' }}>{srtInfo.name}</b>{' '}
                        <span style={{ color: '#94a3b8' }}>({srtInfo.entriesCount} мөр</span>
                        {fullSrtDuration > 0 && (
                          <span style={{ color: '#93c5fd' }}> · нийт урт <b>{formatSecondsHms(fullSrtDuration)}</b></span>
                        )}
                        <span style={{ color: '#94a3b8' }}>)</span>
                      </span>
                    ) : (
                      <span style={{ fontSize: 11.5, color: '#64748b' }}>Эх видеоны Англи .srt хадмал сонгоно уу</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
                    {fullSrtCues.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSrtCuePickerOpen((v) => !v)}
                        style={{
                          padding: '5px 10px',
                          borderRadius: 6,
                          border: '1px solid rgba(59,130,246,0.4)',
                          background: srtCuePickerOpen ? '#2563eb' : 'rgba(59,130,246,0.14)',
                          color: '#fff',
                          fontSize: 11.5,
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        {srtCuePickerOpen ? '▲ Яриа жагсаалт хаах' : '🔍 Харилцан ярианаас цаг сонгох'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handlePickSrt}
                      disabled={running}
                      style={{
                        padding: '5px 12px',
                        fontSize: 11.5,
                        fontWeight: 600,
                        borderRadius: 6,
                        border: '1px solid rgba(59,130,246,0.45)',
                        background: 'rgba(59,130,246,0.18)',
                        color: '#93c5fd',
                        cursor: 'pointer'
                      }}
                    >
                      📋 SRT сонгох
                    </button>
                  </div>
                </div>

                {srtInfo && (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, width: '100%' }}>
                      <SrtBoundPicker
                        title="🟢 Эхлэх цаг"
                        accent="#34d399"
                        valueStr={srtStartTime}
                        maxDuration={fullSrtDuration}
                        minSec={0}
                        emptyDefaultSec={0}
                        resetLabel="00:00:00"
                        cues={fullSrtCues}
                        disabled={running}
                        onChange={(val) => {
                          setSrtStartTime(val);
                          const nextS = parseHmsToSeconds(val);
                          const curE = parseHmsToSeconds(srtEndTime);
                          if (nextS !== null && curE !== null && curE <= nextS) setSrtEndTime('');
                          setPreflight(null);
                        }}
                      />
                      <SrtBoundPicker
                        title="🔴 Дуусах цаг"
                        accent="#f59e0b"
                        valueStr={srtEndTime}
                        maxDuration={fullSrtDuration}
                        minSec={parseHmsToSeconds(srtStartTime) ?? 0}
                        emptyDefaultSec={Math.ceil(fullSrtDuration)}
                        resetLabel="Төгсгөл хүртэл"
                        cues={fullSrtCues}
                        preferEndCue
                        disabled={running}
                        extraButton={videoInfo?.duration ? {
                          label: `🎞️ Видео урт (+${formatDur(videoInfo.duration)})`,
                          onClick: handleMatchEndToVideoDuration
                        } : undefined}
                        onChange={(val) => { setSrtEndTime(val); setPreflight(null); }}
                      />
                    </div>

                    {srtPreview && !srtPreview.error && (
                      <div
                        style={{
                          minWidth: 0,
                          padding: '8px 12px',
                          borderRadius: 8,
                          background: 'rgba(59,130,246,0.08)',
                          border: '1px solid rgba(59,130,246,0.22)',
                          fontSize: 11.5,
                          color: '#cbd5e1',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 5
                        }}
                      >
                        <div>
                          ✂️ Сонгосон: <b style={{ color: '#fff' }}>{srtPreview.slicedCount}/{srtPreview.totalOriginal} мөр</b>{' '}
                          (<b style={{ color: '#34d399' }}>{formatSecondsHms(srtPreview.totalDuration)}</b>)
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                          {srtPreview.firstCue && (
                            <div style={{ minWidth: 0, color: '#93c5fd', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              ▶ [{formatSecondsHms(srtPreview.startSec + srtPreview.firstCue.start)}]: {srtPreview.firstCue.text}
                            </div>
                          )}
                          {srtPreview.lastCue && (
                            <div style={{ minWidth: 0, color: '#fcd34d', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              ⏹ [{formatSecondsHms(srtPreview.startSec + srtPreview.lastCue.end)}]: {srtPreview.lastCue.text}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {srtPreview?.error && (
                      <div style={{ fontSize: 11.5, color: '#f87171' }}>⚠️ {srtPreview.error}</div>
                    )}

                    {srtCuePickerOpen && fullSrtCues.length > 0 && (
                      <div
                        style={{
                          padding: 10,
                          borderRadius: 8,
                          background: '#090d16',
                          border: '1px solid rgba(59,130,246,0.35)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8
                        }}
                      >
                        <input
                          type="text"
                          placeholder="Үг эсвэл цагаар шүүх (ж. castle эсвэл 00:24)..."
                          value={srtCueSearch}
                          onChange={(e) => setSrtCueSearch(e.target.value)}
                          style={{ padding: '6px 10px', borderRadius: 6, background: '#111625', border: '1px solid rgba(255,255,255,0.14)', color: '#fff', fontSize: 12 }}
                        />
                        <div style={{ maxHeight: 170, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {fullSrtCues
                            .filter((cue) => {
                              const q = srtCueSearch.trim().toLowerCase();
                              if (!q) return true;
                              const ts = `${formatSecondsHms(cue.start)} ${formatSecondsHms(cue.end)}`;
                              return cue.text.toLowerCase().includes(q) || ts.includes(q);
                            })
                            .slice(0, 150)
                            .map((cue) => {
                              const startTs = formatSecondsHms(cue.start);
                              const endTs = formatSecondsHms(cue.end);
                              return (
                                <div
                                  key={cue.id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                    padding: '5px 8px',
                                    borderRadius: 6,
                                    background: 'rgba(255,255,255,0.03)',
                                    fontSize: 11.5
                                  }}
                                >
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <span style={{ color: '#60a5fa', fontFamily: 'monospace', marginRight: 8 }}>[{startTs}]</span>
                                    <span style={{ color: '#e2e8f0' }}>{cue.text}</span>
                                  </div>
                                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                                    <button
                                      type="button"
                                      onClick={() => { setSrtStartTime(startTs); setPreflight(null); }}
                                      style={{ padding: '3px 9px', borderRadius: 5, border: 'none', background: 'rgba(16,185,129,0.22)', color: '#34d399', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                                    >
                                      🟢 Эхлэх болгох
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => { setSrtEndTime(endTs); setPreflight(null); }}
                                      style={{ padding: '3px 9px', borderRadius: 5, border: 'none', background: 'rgba(245,158,11,0.22)', color: '#fbbf24', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                                    >
                                      🔴 Дуусах болгох
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Pipeline Preset, Bitrate Custom & File Size Estimate Card */}
              <div
                style={{
                  background: 'rgba(255,255,255,0.025)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 10,
                  padding: '12px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
                    <span style={{ color: '#10b981', fontWeight: 700 }}>⚡ Whisper & Хадмал:</span>
                    <span>
                      <b>{whisperModels.find((m) => m.id === whisperModel)?.label || whisperModel}</b>
                    </span>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#93c5fd' }}>
                      <input
                        type="checkbox"
                        checked={compactCaptions}
                        disabled={running}
                        onChange={(e) => setCompactCaptions(e.target.checked)}
                      />
                      <span>Богино хадмал · 2 мөр</span>
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div
                      style={{
                        padding: '4px 10px',
                        borderRadius: 8,
                        background: 'rgba(16,185,129,0.12)',
                        border: '1px solid rgba(16,185,129,0.35)',
                        fontSize: 11.5,
                        color: '#a7f3d0',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6
                      }}
                      title={`${durationEstimate.source} (${formatDur(durationEstimate.sec)}) · ${exportEstimate.totalKbps.toLocaleString()} Kbps`}
                    >
                      <span>📦 Тооцоолсон хэмжээ:</span>
                      <b style={{ color: '#fff', fontSize: 12.5 }}>{exportEstimate.formatted}</b>
                      <span style={{ color: '#6ee7b7', fontSize: 10.5 }}>({durationEstimate.source})</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowAdvanced((v) => !v)}
                      style={{
                        padding: '5px 10px',
                        fontSize: 11.5,
                        fontWeight: 600,
                        borderRadius: 6,
                        border: '1px solid rgba(255,255,255,0.14)',
                        background: 'rgba(255,255,255,0.05)',
                        color: '#cbd5e1',
                        cursor: 'pointer'
                      }}
                    >
                      {showAdvanced ? '▲ Тохиргоо хураах' : '⚙️ Дэлгэрэнгүй тохиргоо'}
                    </button>
                  </div>
                </div>

                {/* Always-visible Export Resolution, Codec, Bit rate Custom / Kbps / CBR-VBR */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                    gap: 10,
                    paddingTop: 8,
                    borderTop: '1px solid rgba(255,255,255,0.06)'
                  }}
                >
                  <label style={{ fontSize: 11, color: '#94a3b8' }}>
                    Resolution
                    <select
                      value={resolution}
                      disabled={running}
                      onChange={(e) => setResolution(e.target.value as ResolutionOption)}
                      style={{ width: '100%', marginTop: 3, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}
                    >
                      <option value="480P">480P</option>
                      <option value="720P">720P (HD)</option>
                      <option value="1080P">1080P (Full HD)</option>
                      <option value="2K">2K (1440P)</option>
                      <option value="4K">4K (2160P)</option>
                    </select>
                  </label>

                  <label style={{ fontSize: 11, color: '#94a3b8' }}>
                    Bit rate
                    <select
                      value={bitrateOption}
                      disabled={running}
                      onChange={(e) => setBitrateOption(e.target.value as BitrateOption)}
                      style={{ width: '100%', marginTop: 3, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}
                    >
                      <option value="lower">Lower</option>
                      <option value="recommended">Recommended</option>
                      <option value="higher">Higher</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>

                  <label style={{ fontSize: 11, color: '#94a3b8' }}>
                    Codec ({activeEncoderLabel})
                    <select
                      value={codec}
                      disabled={running}
                      onChange={(e) => setCodec(e.target.value as any)}
                      style={{ width: '100%', marginTop: 3, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}
                    >
                      <option value="hevc">HEVC ({detectedEncoders.hevc || 'libx265'})</option>
                      <option value="h264">H.264 ({detectedEncoders.h264 || 'libx264'})</option>
                      <option value="av1">AV1 ({detectedEncoders.av1 || 'libaom-av1'})</option>
                    </select>
                  </label>

                  <label style={{ fontSize: 11, color: '#94a3b8' }}>
                    FPS
                    <select
                      value={fps}
                      disabled={running}
                      onChange={(e) => setFps(Number(e.target.value))}
                      style={{ width: '100%', marginTop: 3, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}
                    >
                      <option value={24}>24 fps</option>
                      <option value={30}>30 fps</option>
                      <option value={60}>60 fps</option>
                    </select>
                  </label>
                </div>

                {bitrateOption === 'custom' && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 16,
                      flexWrap: 'wrap',
                      padding: '8px 12px',
                      borderRadius: 8,
                      background: '#0b0f1a',
                      border: '1px solid rgba(255,255,255,0.08)',
                      fontSize: 12
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="number"
                        min={200}
                        max={100000}
                        step={100}
                        value={customBitrate}
                        disabled={running}
                        onChange={(e) => setCustomBitrate(Math.max(200, Number(e.target.value) || 1000))}
                        style={{
                          width: 110,
                          padding: '5px 8px',
                          borderRadius: 6,
                          border: '1px solid rgba(255,255,255,0.18)',
                          background: '#111625',
                          color: '#fff',
                          fontSize: 12.5
                        }}
                      />
                      <span style={{ color: '#94a3b8' }}>Kbps</span>
                    </div>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#e2e8f0' }}>
                      <input
                        type="radio"
                        name="autoBitrateType"
                        value="cbr"
                        checked={bitrateType === 'cbr'}
                        disabled={running}
                        onChange={() => setBitrateType('cbr')}
                      />
                      <span>CBR (Static Bit Rate)</span>
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#e2e8f0' }}>
                      <input
                        type="radio"
                        name="autoBitrateType"
                        value="vbr"
                        checked={bitrateType === 'vbr'}
                        disabled={running}
                        onChange={() => setBitrateType('vbr')}
                      />
                      <span>VBR (Variable Bit Rate)</span>
                    </label>
                    <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#94a3b8' }}>
                      Нийт: {exportEstimate.videoKbps.toLocaleString()} + {exportEstimate.audioKbps} Kbps аудио ≈{' '}
                      <b style={{ color: '#34d399' }}>{exportEstimate.formatted}</b>
                    </span>
                  </div>
                )}

                {showAdvanced && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                    {/* Column 1: Voice & Whisper */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 700, color: '#cbd5e1' }}>🎙️ ElevenLabs & Whisper</div>
                      <label style={{ fontSize: 11, color: '#94a3b8' }}>
                        Дуу хоолой
                        <select
                          value={voiceId}
                          disabled={running}
                          onChange={(e) => setVoiceId(e.target.value)}
                          style={{ width: '100%', marginTop: 3, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}
                        >
                          {voices.length ? voices.map((v) => (
                            <option key={v.id} value={v.id}>{v.name}</option>
                          )) : (
                            <option value={DEFAULT_VOICE_ID}>Default Voice ({DEFAULT_VOICE_ID})</option>
                          )}
                        </select>
                      </label>
                      <label style={{ fontSize: 11, color: '#94a3b8' }}>
                        ElevenLabs загвар
                        <select
                          value={elevenModelId}
                          disabled={running}
                          onChange={(e) => setElevenModelId(e.target.value)}
                          style={{ width: '100%', marginTop: 3, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}
                        >
                          {ttsModels.length ? ttsModels.map((m) => (
                            <option key={m.id} value={m.id}>{m.label || m.id}</option>
                          )) : (
                            <>
                              <option value="eleven_v4">ElevenLabs v4</option>
                              <option value="eleven_multilingual_v2">Multilingual v2</option>
                              <option value="eleven_flash_v2_5">Flash v2.5</option>
                              <option value="eleven_turbo_v2_5">Turbo v2.5</option>
                            </>
                          )}
                        </select>
                      </label>
                      <label style={{ fontSize: 11, color: '#94a3b8' }}>
                        Монгол яриа таних загвар
                        <select
                          value={whisperModel}
                          disabled={running}
                          onChange={(e) => setWhisperModel(e.target.value)}
                          style={{ width: '100%', marginTop: 3, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}
                        >
                          {whisperModels.length ? whisperModels.map((m) => (
                            <option key={m.id} value={m.id} disabled={!m.installed}>
                              {m.label}{m.installed ? '' : ' (суулгаагүй)'}
                            </option>
                          )) : (
                            <option value="groq-whisper-large-v3">⚡ Groq Cloud · Large v3</option>
                          )}
                        </select>
                      </label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <label style={{ fontSize: 11, color: '#94a3b8' }}>
                          Хурд ({speed.toFixed(2)}x)
                          <input type="range" min={0.7} max={1.2} step={0.05} value={speed} disabled={running} onChange={(e) => setSpeed(Number(e.target.value))} style={{ width: '100%' }} />
                        </label>
                        <label style={{ fontSize: 11, color: '#94a3b8' }}>
                          Тогтвортой ({Math.round(stability * 100)}%)
                          <input type="range" min={0} max={1} step={0.05} value={stability} disabled={running} onChange={(e) => setStability(Number(e.target.value))} style={{ width: '100%' }} />
                        </label>
                      </div>
                    </div>

                    {/* Column 2: Extra Export Params */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 700, color: '#cbd5e1' }}>🎬 Нэмэлт экспорт</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <label style={{ fontSize: 11, color: '#94a3b8' }}>
                          Харьцаа
                          <select value={aspect} disabled={running} onChange={(e) => setAspect(e.target.value as any)} style={{ width: '100%', marginTop: 3, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}>
                            <option value="auto">Эх видео шиг</option>
                            <option value="16:9">16:9 (Хэвтээ)</option>
                            <option value="9:16">9:16 (Босоо)</option>
                          </select>
                        </label>
                        <label style={{ fontSize: 11, color: '#94a3b8' }}>
                          Формат
                          <select value={format} disabled={running} onChange={(e) => setFormat(e.target.value as any)} style={{ width: '100%', marginTop: 3, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}>
                            <option value="mp4">MP4</option>
                            <option value="mov">MOV</option>
                          </select>
                        </label>
                        <label style={{ fontSize: 11, color: '#94a3b8' }}>
                          Аудио Bitrate
                          <select value={audioBitrate} disabled={running} onChange={(e) => setAudioBitrate(e.target.value as any)} style={{ width: '100%', marginTop: 3, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}>
                            <option value="128k">128 Kbps</option>
                            <option value="192k">192 Kbps</option>
                            <option value="320k">320 Kbps</option>
                          </select>
                        </label>
                        <label style={{ fontSize: 11, color: '#94a3b8' }}>
                          Кодчилох хурд
                          <select value={quality} disabled={running} onChange={(e) => setQuality(e.target.value as any)} style={{ width: '100%', marginTop: 3, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}>
                            <option value="draft">Draft (Хурдан)</option>
                            <option value="standard">Standard</option>
                            <option value="high">High (Дээд)</option>
                          </select>
                        </label>
                      </div>
                    </div>

                    {/* Column 3: Storage & Post-Actions */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 700, color: '#cbd5e1' }}>💾 Хадгалалт & Төсөл</div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="text"
                          value={exportDir}
                          disabled={running}
                          onChange={(e) => setExportDir(e.target.value)}
                          placeholder="Экспортын хавтас"
                          style={{ flex: 1, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)', fontSize: 11 }}
                        />
                        <button
                          type="button"
                          onClick={handlePickExportFolder}
                          disabled={running}
                          style={{ padding: '5px 9px', borderRadius: 6, background: 'rgba(255,255,255,0.08)', color: '#e2e8f0', border: 'none', fontSize: 11, cursor: 'pointer' }}
                        >
                          📁
                        </button>
                      </div>
                      <label style={{ fontSize: 11, color: '#94a3b8' }}>
                        Gemini загвар (SRT Sync)
                        <select value={geminiModel} disabled={running} onChange={(e) => setGeminiModel(e.target.value)} style={{ width: '100%', marginTop: 3, padding: '5px 7px', borderRadius: 6, background: '#0b0f1a', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}>
                          <option value="gemini-3.6-flash">Gemini 3.6 Flash (Зөвлөмж)</option>
                          <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                          <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                        </select>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: '#cbd5e1', cursor: 'pointer' }}>
                        <input type="checkbox" checked={saveProjectToLibrary} disabled={running} onChange={(e) => setSaveProjectToLibrary(e.target.checked)} />
                        <span>Хадмалгүй цэвэр төслийг Library-д хадгалах</span>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: '#cbd5e1', cursor: 'pointer' }}>
                        <input type="checkbox" checked={openProjectAfterExport} disabled={running} onChange={(e) => setOpenProjectAfterExport(e.target.checked)} />
                        <span>Экспорт дуусахад Timeline дээр шууд нээх</span>
                      </label>
                    </div>
                  </div>
                )}
              </div>

              {/* Preflight Check Results */}
              {preflight && (
                <div
                  style={{
                    background: preflight.ok ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.1)',
                    border: `1px solid ${preflight.ok ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.35)'}`,
                    borderRadius: 10,
                    padding: '10px 14px',
                    fontSize: 12
                  }}
                >
                  <div style={{ fontWeight: 700, color: preflight.ok ? '#34d399' : '#f87171', marginBottom: 6 }}>
                    {preflight.ok ? '✅ Бүх шалгалт амжилттай — Авто эхлүүлэхэд бэлэн!' : `❌ ${preflight.error}`}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {(preflight.checks || []).map((c) => (
                      <span
                        key={c.id}
                        style={{
                          padding: '3px 9px',
                          borderRadius: 999,
                          fontSize: 11,
                          background: c.ok ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.2)',
                          color: c.ok ? '#a7f3d0' : '#fecaca'
                        }}
                      >
                        {c.ok ? '✓' : '✕'} {c.label}: {c.detail}
                      </span>
                    ))}
                  </div>
                  {(preflight.warnings || []).map((w, idx) => (
                    <div key={idx} style={{ marginTop: 6, color: '#fbbf24', fontSize: 11.5 }}>⚠️ {w}</div>
                  ))}
                </div>
              )}

              {/* 5-Stage Progress Tracker */}
              {(running || progress || result) && (
                <div
                  style={{
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 10,
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10
                  }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
                    {STEPS.map((st, idx) => {
                      const stepNum = idx + 1;
                      const currentStep = progress?.stepIndex || 0;
                      const isComplete =
                        Boolean(result?.ok) ||
                        Boolean(result?.completedStages?.includes(st.key)) ||
                        currentStep > stepNum;
                      const isActive = running && currentStep === stepNum;
                      return (
                        <div
                          key={st.key}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 8,
                            border: `1px solid ${
                              isComplete
                                ? 'rgba(16,185,129,0.45)'
                                : isActive
                                ? 'rgba(59,130,246,0.6)'
                                : 'rgba(255,255,255,0.08)'
                            }`,
                            background: isComplete
                              ? 'rgba(16,185,129,0.12)'
                              : isActive
                              ? 'rgba(59,130,246,0.16)'
                              : 'rgba(255,255,255,0.02)'
                          }}
                        >
                          <div style={{ fontSize: 12, fontWeight: 700, color: isComplete ? '#34d399' : isActive ? '#60a5fa' : '#94a3b8' }}>
                            {isComplete ? '✅' : isActive ? '⏳' : st.icon} {st.title}
                          </div>
                          <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2 }}>{st.subtitle}</div>
                        </div>
                      );
                    })}
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: '#cbd5e1', marginBottom: 4 }}>
                      <span>{progress?.message || (result?.ok ? 'Бүх шат амжилттай дууслаа!' : 'Бэлдэж байна...')}</span>
                      <b>{result?.ok ? 100 : (progress?.overallPct ?? 0)}%</b>
                    </div>
                    <div style={{ height: 8, borderRadius: 999, background: '#0b0f1a', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${result?.ok ? 100 : (progress?.overallPct ?? 0)}%`,
                          background: result?.ok ? '#10b981' : 'linear-gradient(90deg, #10b981, #3b82f6)',
                          transition: 'width 0.25s ease'
                        }}
                      />
                    </div>
                  </div>

                  {logs.length > 0 && (
                    <div
                      style={{
                        maxHeight: 110,
                        overflowY: 'auto',
                        background: '#090d16',
                        borderRadius: 6,
                        padding: '8px 10px',
                        fontSize: 11,
                        color: '#94a3b8',
                        fontFamily: 'monospace'
                      }}
                    >
                      {logs.map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Completion or Failure Card */}
              {result && (
                <div
                  style={{
                    background: result.ok ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                    border: `1px solid ${result.ok ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)'}`,
                    borderRadius: 10,
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10
                  }}
                >
                  {result.ok ? (
                    <>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#34d399' }}>
                        🎉 Бэлэн боллоо! Хадмал цэвэрлэгдэн устгагдаж, эцсийн видео экспортлогдлоо.
                      </div>
                      <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.55 }}>
                        <div><b>Файл:</b> {result.outPath}</div>
                        {result.report && (
                          <div>
                            <b>Тайлан:</b> {result.report.width}×{result.report.height} ·{' '}
                            {formatDur(result.report.exportDuration)} · {result.report.videoClipCount} клип (
                            {result.report.motionCount} motion, {result.report.freezeCount} freeze) · Үлдсэн түр хадмал:{' '}
                            <b>{result.report.finalTextClipCount}</b>
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        {result.outPath && (
                          <>
                            <button
                              type="button"
                              onClick={() => window.api.openExportPath?.(result.outPath!)}
                              style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#10b981', color: '#042f2e', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
                            >
                              ▶️ Видеог тоглуулах
                            </button>
                            <button
                              type="button"
                              onClick={() => window.api.showItemInFolder?.(result.outPath!)}
                              style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
                            >
                              📁 Хавтас нээх
                            </button>
                          </>
                        )}
                        {onOpenProject && (result.savedProjectId || result.savedProjectPath) && (
                          <button
                            type="button"
                            onClick={() => onOpenProject(result.savedProjectId, result.savedProjectPath)}
                            style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
                          >
                            🎬 Цэвэр төслийг Timeline дээр нээх
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: '#f87171' }}>
                        {result.canceled ? '⛔ Хэрэглэгч зогсоолоо' : '❌ Алдаа гарлаа'}
                      </div>
                      <div style={{ fontSize: 12, color: '#fecaca', whiteSpace: 'pre-wrap' }}>{result.error}</div>
                      {activeJobId && (
                        <div>
                          <button
                            type="button"
                            onClick={() => handleResumeJob(activeJobId)}
                            disabled={running}
                            style={{
                              padding: '7px 14px',
                              borderRadius: 8,
                              border: 'none',
                              background: '#f59e0b',
                              color: '#1f2937',
                              fontWeight: 700,
                              fontSize: 12,
                              cursor: 'pointer'
                            }}
                          >
                            🔄 Зогссон алхмаас үргэлжлүүлэх (Кредит дахин үрэхгүй)
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {activeTab === 'batch' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff' }}>Олон анги дараалан авто хийх жагсаалт</div>
                  <div style={{ fontSize: 11.5, color: '#94a3b8' }}>
                    "Нэг анги" цонхонд Скрипт + Видео + SRT-ээ бөглөөд "+ Багцад нэмэх" дарснаар дараалалд орно.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={handleRunBatch}
                    disabled={batchRunning || running || batchQueue.length === 0}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 8,
                      border: 'none',
                      background: '#3b82f6',
                      color: '#fff',
                      fontWeight: 700,
                      fontSize: 12.5,
                      cursor: batchRunning || batchQueue.length === 0 ? 'not-allowed' : 'pointer',
                      opacity: batchRunning || batchQueue.length === 0 ? 0.5 : 1
                    }}
                  >
                    🚀 Багцыг эхлүүлэх ({batchQueue.length})
                  </button>
                </div>
              </div>

              {batchQueue.length === 0 ? (
                <div style={{ padding: 36, textAlign: 'center', color: '#64748b', background: 'rgba(255,255,255,0.02)', borderRadius: 10 }}>
                  Одоогоор багцад нэмэгдсэн анги алга байна.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {batchQueue.map((item, idx) => (
                    <div
                      key={item.id}
                      style={{
                        padding: '10px 14px',
                        borderRadius: 8,
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>
                          #{idx + 1} · {item.outputName}
                        </div>
                        <div style={{ fontSize: 11, color: '#94a3b8' }}>
                          {item.videoName} · {item.srtName} · {item.scriptText.length} тэмдэгт
                          {item.srtStartTime ? ` · SRT ${item.srtStartTime}` : ''}
                        </div>
                        {item.error && <div style={{ fontSize: 11, color: '#f87171', marginTop: 3 }}>{item.error}</div>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        <span
                          style={{
                            padding: '3px 9px',
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 600,
                            background:
                              item.status === 'completed'
                                ? 'rgba(16,185,129,0.2)'
                                : item.status === 'running'
                                ? 'rgba(59,130,246,0.2)'
                                : item.status === 'failed'
                                ? 'rgba(239,68,68,0.2)'
                                : 'rgba(255,255,255,0.08)',
                            color:
                              item.status === 'completed'
                                ? '#34d399'
                                : item.status === 'running'
                                ? '#60a5fa'
                                : item.status === 'failed'
                                ? '#f87171'
                                : '#cbd5e1'
                          }}
                        >
                          {item.status}
                        </span>
                        {item.outPath && (
                          <button
                            type="button"
                            onClick={() => window.api.showItemInFolder?.(item.outPath!)}
                            style={{ padding: '4px 8px', borderRadius: 6, border: 'none', background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 11, cursor: 'pointer' }}
                          >
                            📁
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={batchRunning}
                          onClick={() => setBatchQueue((prev) => prev.filter((x) => x.id !== item.id))}
                          style={{ padding: '4px 8px', borderRadius: 6, border: 'none', background: 'rgba(239,68,68,0.16)', color: '#fca5a5', fontSize: 11, cursor: 'pointer' }}
                        >
                          Устгах
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff' }}>Өмнөх болон түр зогссон ажлууд</div>
                <button
                  type="button"
                  onClick={loadHistory}
                  style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.05)', color: '#cbd5e1', fontSize: 11.5, cursor: 'pointer' }}
                >
                  ↻ Шинэчлэх
                </button>
              </div>
              {jobHistory.length === 0 ? (
                <div style={{ padding: 36, textAlign: 'center', color: '#64748b', background: 'rgba(255,255,255,0.02)', borderRadius: 10 }}>
                  Түүх хоосон байна.
                </div>
              ) : (
                jobHistory.map((job) => (
                  <div
                    key={job.jobId}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 8,
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>
                        {job.outputName || job.jobId} · <span style={{ color: job.status === 'completed' ? '#34d399' : '#fbbf24' }}>{job.status}</span>
                      </div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>
                        Алхмууд: {job.completedStages.join(' → ') || 'эхлээгүй'} · {new Date(job.updatedAt).toLocaleString()}
                      </div>
                      {job.error && <div style={{ fontSize: 11, color: '#f87171', marginTop: 2 }}>{job.error}</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      {job.status !== 'completed' && (
                        <button
                          type="button"
                          disabled={running}
                          onClick={() => { setActiveTab('single'); handleResumeJob(job.jobId); }}
                          style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: '#f59e0b', color: '#111827', fontWeight: 700, fontSize: 11.5, cursor: 'pointer' }}
                        >
                          🔄 Үргэлжлүүлэх
                        </button>
                      )}
                      {job.outPath && (
                        <button
                          type="button"
                          onClick={() => window.api.showItemInFolder?.(job.outPath!)}
                          style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontSize: 11.5, cursor: 'pointer' }}
                        >
                          📁 Хавтас
                        </button>
                      )}
                      {onOpenProject && job.savedProjectId && (
                        <button
                          type="button"
                          onClick={() => onOpenProject(job.savedProjectId, null)}
                          style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: '#6366f1', color: '#fff', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
                        >
                          🎬 Төсөл нээх
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            background: '#0d111d',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12
          }}
        >
          <div style={{ display: 'flex', gap: 8 }}>
            {activeTab === 'single' && (
              <>
                <button
                  type="button"
                  onClick={handlePreflight}
                  disabled={checkingPreflight || running}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.16)',
                    background: 'rgba(255,255,255,0.06)',
                    color: '#e2e8f0',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  {checkingPreflight ? 'Шалгаж байна...' : '🔍 Урьдчилан шалгах'}
                </button>
                <button
                  type="button"
                  onClick={handleAddCurrentToBatch}
                  disabled={running || !scriptText.trim() || !videoInfo?.path || !srtInfo?.path}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 8,
                    border: '1px solid rgba(59,130,246,0.35)',
                    background: 'rgba(59,130,246,0.12)',
                    color: '#93c5fd',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: running || !scriptText.trim() || !videoInfo?.path || !srtInfo?.path ? 'not-allowed' : 'pointer',
                    opacity: !scriptText.trim() || !videoInfo?.path || !srtInfo?.path ? 0.5 : 1
                  }}
                >
                  + Багцад нэмэх
                </button>
              </>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {activeTab === 'single' && (
              <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
                {resolution} · {bitrateOption === 'custom' ? `${customBitrate} Kbps ${bitrateType.toUpperCase()}` : bitrateOption} ·{' '}
                <b style={{ color: '#34d399' }}>~{exportEstimate.formatted}</b>
              </span>
            )}
            {(running || batchRunning) ? (
              <button
                type="button"
                onClick={handleCancel}
                style={{
                  padding: '9px 18px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#ef4444',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: 'pointer'
                }}
              >
                ⛔ Зогсоох
              </button>
            ) : activeTab === 'single' ? (
              <button
                type="button"
                onClick={handleStartSingle}
                disabled={checkingPreflight || !scriptText.trim() || !videoInfo?.path || !srtInfo?.path}
                style={{
                  padding: '9px 22px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'linear-gradient(135deg, #10b981 0%, #3b82f6 100%)',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 800,
                  cursor: !scriptText.trim() || !videoInfo?.path || !srtInfo?.path ? 'not-allowed' : 'pointer',
                  opacity: !scriptText.trim() || !videoInfo?.path || !srtInfo?.path ? 0.45 : 1,
                  boxShadow: '0 4px 16px rgba(16,185,129,0.35)'
                }}
              >
                🚀 БҮРЭН АВТО ЭХЛҮҮЛЭХ
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
