export type BitrateOption = 'lower' | 'recommended' | 'higher' | 'custom';
export type BitrateType = 'cbr' | 'vbr';
export type ResolutionOption = '480P' | '720P' | '1080P' | '2K' | '4K';

export interface ExportSizeEstimateInput {
  exportVideo?: boolean;
  exportAudio?: boolean;
  bitrateOption: BitrateOption;
  customBitrate?: number;
  resolution: ResolutionOption;
  fps?: number;
  audioBitrate?: string | number;
  durationSec: number;
}

export function getVideoBitrateKbps({
  exportVideo = true,
  bitrateOption,
  customBitrate = 1000,
  resolution,
  fps = 30
}: Omit<ExportSizeEstimateInput, 'exportAudio' | 'audioBitrate' | 'durationSec'>): number {
  if (!exportVideo) return 0;
  if (bitrateOption === 'custom') {
    return Math.max(100, Number(customBitrate) || 1000);
  }
  const base =
    resolution === '480P' ? 2000
    : resolution === '720P' ? 4000
    : resolution === '1080P' ? 8000
    : resolution === '2K' ? 14000
    : 28000;
  const fpsMultiplier = (fps || 30) / 30;
  const qualityMultiplier = bitrateOption === 'higher' ? 1.5 : bitrateOption === 'lower' ? 0.6 : 1.0;
  return Math.round(base * fpsMultiplier * qualityMultiplier);
}

export function estimateExportSizeBytes(input: ExportSizeEstimateInput): {
  videoKbps: number;
  audioKbps: number;
  totalKbps: number;
  bytes: number;
  mb: number;
  gb: number;
  formatted: string;
} {
  const videoKbps = getVideoBitrateKbps(input);
  const audioKbps = input.exportAudio !== false ? (parseInt(String(input.audioBitrate || 192), 10) || 192) : 0;
  const totalKbps = videoKbps + audioKbps;
  const dur = Math.max(0, Number(input.durationSec) || 0);
  const bytes = ((totalKbps * 1000) / 8) * dur;
  const mb = bytes / (1024 * 1024);
  const gb = mb / 1024;
  const formatted = dur <= 0
    ? '—'
    : mb >= 1024
    ? `${gb.toFixed(2)} GB`
    : `${Math.max(1, Math.round(mb))} MB`;

  return { videoKbps, audioKbps, totalKbps, bytes, mb, gb, formatted };
}

export function formatSecondsHms(seconds: number): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function parseHmsToSeconds(value: string): number | null {
  const clean = String(value || '').trim();
  if (!clean) return null;
  if (/^\d+(\.\d+)?$/.test(clean)) return Math.max(0, Math.floor(parseFloat(clean)));
  const parts = clean.split(':').map((p) => Number(p.trim()));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
  return null;
}
