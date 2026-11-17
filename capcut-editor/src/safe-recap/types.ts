import type { Keyframe } from '../types';

export interface SafeCropRect {
  x: number; // 0..1 normalized relative to original panel width
  y: number; // 0..1 normalized relative to original panel height
  w: number; // 0.05..1
  h: number; // 0.05..1
}

export type SafeCensorMode = 'blur' | 'mosaic' | 'bar' | 'glow';

export interface SafeCensorBox {
  id: string;
  x: number; // 0..1 normalized relative to original panel width
  y: number; // 0..1 normalized relative to original panel height
  w: number; // 0.02..1
  h: number; // 0.02..1
  mode: SafeCensorMode;
  strength?: number; // 1..40
}

export type SafeStatus = 'safe' | 'cropped' | 'blurred' | 'excluded' | 'unchecked';
export type SafeStrictness = 'lenient' | 'balanced' | 'strict';
export type SafeMotionType = 'zoom_in' | 'zoom_out' | 'pan_down' | 'pan_up' | 'static';

export interface SafeDetectedBox {
  rect: SafeCropRect;
  label: string;
  score: number;
}

export interface SafePanelItem {
  id: string;
  name: string;
  path: string;
  width: number;
  height: number;
  isSliced?: boolean;
  originalPath?: string;
  panelIndex?: number;
  safetyStatus: SafeStatus;
  nsfwScore: number;
  explicitScore?: number;
  suggestiveScore?: number;
  faceBoxes: SafeCropRect[];
  nsfwBoxes: SafeDetectedBox[];
  cropRect?: SafeCropRect | null;
  censorBoxes: SafeCensorBox[];
  sanitizedThumbPath?: string;
  sanitizedRenderPath?: string;
  sanitizedWidth?: number;
  sanitizedHeight?: number;
  recheckSafe?: boolean;
  needsReview?: boolean;
  safetyReason?: string;
}

export interface SafeBeat {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface SafePlanRow {
  id: string;
  beatId: string;
  start: number;
  end: number;
  duration: number;
  text: string;
  panelId: string;
  imagePath: string;
  sanitizedPath?: string;
  imageWidth: number;
  imageHeight: number;
  imageName: string;
  safetyStatus: SafeStatus;
  cropRect?: SafeCropRect | null;
  censorBoxes: SafeCensorBox[];
  needsReview?: boolean;
  safetyReason?: string;
  isFallback?: boolean;
  motion: SafeMotionType;
  aspect: '16:9' | '9:16';
  confidence: number;
  keyframes: Keyframe[];
  aiReason?: string;
}

export interface SafeEnvStatus {
  ok: boolean;
  pythonPath: string | null;
  hasImgutils: boolean;
  hasOnnxGpu: boolean;
  hasOpencv: boolean;
  providers?: string[];
  error?: string;
}

export interface SafeWhisperModel {
  id: string;
  label: string;
  installed: boolean;
  note?: string;
}

export interface SafeSessionSummary {
  id: string;
  name: string;
  updatedAt: number;
  panelCount: number;
  safeCount: number;
  reviewCount: number;
  excludedCount: number;
  beatCount: number;
  planCount: number;
  inputMode: 'script' | 'audio_srt';
  completedStages: string[];
  audioPath?: string;
  audioDuration?: number;
  subtitleMethod?: string;
  scriptPreview?: string;
}

export interface SafeRecapSession {
  id: string;
  name: string;
  updatedAt: number;
  inputMode: 'script' | 'audio_srt';
  scriptText: string;
  audioPath: string;
  audioName: string;
  audioDuration: number;
  subFileName: string;
  subtitles: SafeBeat[];
  draftSubtitles?: SafeBeat[];
  subtitleMethod?: string;
  whisperModel?: string;
  autoTagScript?: boolean;
  rawPickedPaths: string[];
  sliceMode: 'none' | 'smart';
  censorMode: SafeCensorMode;
  strictness: SafeStrictness;
  aspectRatio: '16:9' | '9:16';
  fitMode: 'contain' | 'cover';
  includeCaptions: boolean;
  completedStages?: string[];
  panels: SafePanelItem[];
  plan: SafePlanRow[];
}
