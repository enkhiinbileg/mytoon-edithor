import type { ProjectApi, ProjectDocument } from './project-types';
export type MediaKind = 'video' | 'audio' | 'image' | 'unknown';
export type TrackKind = 'video' | 'audio' | 'overlay';

/** What a clip actually is. 'av' clips reference imported media; the others are
 *  generated in the app and have no source file. */
export type ClipKind = 'av' | 'text' | 'sticker';

export interface MediaItem {
  id: string;
  path: string;
  name: string;
  kind: MediaKind;
  duration: number; // seconds
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  thumbs: string[]; // media:// urls, evenly spaced through the source
  isInternal?: boolean;
}

export interface WaveformData {
  ok: boolean;
  duration: number;
  pointsPerSecond: number;
  peaks: number[];
  error?: string;
}

export interface TextStyle {
  text: string;
  fontSize: number;   // px at project resolution
  color: string;
  bold: boolean;
  shadow: boolean;
  background: string; // '' for none
  fontFamily?: string;
  fontPath?: string;
  stroke?: boolean;
  strokeColor?: string;
  strokeWidth?: number;
}

export interface FontItem {
  id: string;
  name: string;
  family: string;
  fileName?: string;
  path?: string;
  category: 'capcut' | 'system' | 'custom';
}

export interface FontCatalog {
  capcut: FontItem[];
  system: FontItem[];
  custom: FontItem[];
  all: FontItem[];
}

export interface Clip {
  id: string;
  kind: ClipKind;
  trackId: string;
  start: number;    // position on the timeline, seconds
  inPoint: number;  // source in, seconds (0 for generated clips)
  outPoint: number; // source out, seconds

  /** Only for kind === 'av'. */
  mediaId?: string;
  label?: string;

  /** Only for text / sticker clips. Position is the centre, normalised 0..1. */
  style?: TextStyle;
  sticker?: string;
  x?: number;
  y?: number;

  /** Visual clip transform and sizing. */
  scale?: number;
  rotation?: number; // degrees, -360..360
  fitMode?: 'contain' | 'cover';

  /** Keyframe animation markers. */
  keyframes?: Keyframe[];

  /** Looks. */
  filterId?: string;
  effectId?: string;
  transitionId?: string;      // transition *into* the next clip on the track
  transitionDuration?: number;

  volume?: number;  // 0..2, av clips
  opacity?: number; // 0..1

  /** Bilingual Recap alignment metadata (optional) */
  matchedSrtId?: number;
  englishText?: string;
  mongolianText?: string;
  sourceStart?: number;
  sourceEnd?: number;

  /** Freeze extension & AI verification */
  isFreeze?: boolean;
  freezeTs?: number;
  aiVerified?: boolean;
  aiConfidence?: number;
  aiReason?: string;
}

export interface Keyframe {
  id: string;
  time: number; // seconds relative to clip.start (0 <= time <= clipDuration)
  scale?: number;
  x?: number; // 0..1 (default 0.5)
  y?: number; // 0..1 (default 0.5)
  rotation?: number; // degrees
  opacity?: number; // 0..1
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  height?: number;
}

export const clipDuration = (c: Clip) => c.outPoint - c.inPoint;
export const clipEnd = (c: Clip) => c.start + clipDuration(c);

/** Overlay clips are rasterised in the renderer and composited by ffmpeg. */
export interface OverlayImage {
  dataUrl: string;
  start: number;
  end: number;
  /** Top-left position and size in project pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
}

export interface ExportClipSpec {
  src: string;
  trackId?: string;
  layer?: number;
  kind?: 'video' | 'image';
  opacity?: number;
  /** Timeline position, used to map overlay/audio times onto the render. */
  start: number;
  inPoint: number;
  outPoint: number;
  hasAudio: boolean;
  volume: number;
  filterFf: string;
  effectFf: string;
  transition: string;       // xfade name, '' for a cut
  transitionDuration: number;
  scale?: number;
  rotation?: number;
  fitMode?: 'contain' | 'cover';
  x?: number;
  y?: number;
  keyframes?: Keyframe[];
}

export interface ExportAudioSpec {
  src: string;
  inPoint: number;
  outPoint: number;
  start: number; // timeline position
  volume: number;
}

export interface ExportSpec {
  clips: ExportClipSpec[];
  audio: ExportAudioSpec[];
  overlays: OverlayImage[];
  width: number;
  height: number;
  fps: number;
  outPath: string;
  duration?: number;
  quality?: 'draft' | 'standard' | 'high';
  format?: 'mp4' | 'mov' | 'mp3' | 'wav' | 'aac';
  audioBitrate?: '128k' | '192k' | '320k';
  codec?: 'h264' | 'hevc' | 'av1' | 'hevc_alpha' | 'hevc_422' | 'rle';
  bitrateMode?: 'recommended' | 'higher' | 'lower' | 'custom' | 'cbr' | 'vbr';
  customBitrate?: number;
  exportVideo?: boolean;
}

/** One line of transcript, before and after translation. */
export interface DubSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  translated?: string;
}

/** A synthesised line, already fitted to its slot on the timeline. */
export interface DubClip {
  id: number;
  file: string;
  start: number;
  duration: number;
  tempo: number;
  /** Seconds by which the line still runs past its slot after fitting. */
  overflow: number;
  text: string;
}

/** What survives a restart: the transcript, its translation, and its context. */
export interface DubSession {
  segments: DubSegment[];
  sourcePath?: string;
  language?: string;
}

export interface TranslateProvider {
  id: string;
  label: string;
  /** null when the provider needs no credentials (a local model). */
  keyField: string | null;
  needsKey: boolean;
  defaultModel: string;
  suggestedModels: string[];
  note: string;
}

export interface VoiceProvider {
  id: string;
  label: string;
  keyField: string;
  needsRegion: boolean;
  models: { id: string; label: string; credits: number; note: string; languages?: string[] }[];
}

export interface Voice {
  id: string;
  name: string;
  description?: string;
  locale?: string;
}

export interface ElevenKeyQuota {
  userId?: string;
  tier?: string;
  used: number;
  limit: number;
  remaining: number;
}

export interface ElevenKeyItem {
  id: string;
  label: string;
  maskedKey: string;
  enabled: boolean;
  quota?: ElevenKeyQuota | null;
  status: 'ready' | 'busy' | 'exhausted' | 'insufficient' | 'blocked' | 'cooldown' | 'error';
}

export interface AppSettings {
  anthropicApiKey: boolean;
  geminiApiKey?: boolean;
  elevenLabsApiKey: boolean;
  elevenLabsKeyPool?: ElevenKeyItem[];
  azureSpeechKey?: boolean;
  azureRegion?: string;
  [key: string]: unknown;
}

export interface RecapCutReport {
  captionCount: number;
  matchedCaptionCount: number;
  coveredCaptionCount?: number;
  introCaptionCount?: number;
  sceneCount: number;
  timelineStart: number;
  timelineEnd: number;
  voiceStart: number;
  voiceEnd: number;
  durationError: number;
  alignmentMethod: string;
  warnings: string[];
}

export type RecapCutResult = {
  ok: true;
  videoClips: Clip[];
  newMedia: MediaItem[];
  count: number;
  motionCount: number;
  freezeCount: number;
  englishScenesCount: number;
  videoDuration: number;
  voiceDuration: number;
  report: RecapCutReport;
} | { ok: false; error: string };

declare global {
  interface Window {
    api: ProjectApi & {
      close(): Promise<void>;
      getElevenKeyPool(): Promise<ElevenKeyItem[]>;
      addElevenKey(key: string, label?: string): Promise<{ ok: boolean; pool?: ElevenKeyItem[]; error?: string }>;
      removeElevenKey(keyId: string): Promise<{ ok: boolean; pool?: ElevenKeyItem[]; error?: string }>;
      toggleElevenKey(keyId: string, enabled: boolean): Promise<{ ok: boolean; pool?: ElevenKeyItem[]; error?: string }>;
      refreshElevenQuotas(): Promise<{ ok: boolean; pool?: ElevenKeyItem[]; error?: string }>;
      copyFile?(source: string, target: string): Promise<{ ok: boolean; path?: string; error?: string }>;

      prepareVoiceEdit(spec:{source:string;voice:string;sourceLanguage:string;whisperModel:string;translation:{providerId:string;model:string};sourceSegments?:DubSegment[];voiceSegments?:DubSegment[];promptGuidance?:string;isSilentVideo?:boolean;sourceOffset?:number}):Promise<VoiceEditResult>;
      renderVoiceEdit(spec:{jobId:string;plan:VoiceEditRow[]}):Promise<{ok:boolean;canceled?:boolean;error?:string;path?:string;reportPath?:string;projectPath?:string;renderSeconds?:number;encoder?:string}>;
      syncTimelineVoice(spec:{videoPath:string;voicePath:string;sourceOffset?:number;style?:'dynamic'|'sentence';method?:'auto'|'whisper'|'pause';whisperModel?:string;useVision?:boolean;geminiApiKey?:string;mode?:'freeze'|'motion'|'hybrid'}):Promise<{ok:boolean;error?:string;videoDuration?:number;voiceDuration?:number;cuts?:{id:number;sourceStart:number;sourceEnd:number;targetStart:number;targetEnd:number;duration:number;text?:string;reason?:string;freeze?:boolean;freezeImagePath?:string}[];nextSourceOffset?:number;visionAIUsed?:boolean;visionError?:string}>;
      buildScriptRecap(spec: ScriptStudioSpec): Promise<ScriptStudioResult>;
      pickAudioFolder(): Promise<{ok:boolean;canceled?:boolean;error?:string;dir?:string;token?:string;parts?:{name:string}[]}>;
      mergeAudioFolder(token:string): Promise<{ok:boolean;canceled?:boolean;error?:string;audioPath?:string}>;
      scanVoiceRecovery(): Promise<{ok:boolean;error?:string;token?:string;parts?:{name:string;index:number}[];missing?:number[];ambiguous?:boolean;startedAt?:number|null}>;
      mergeVoiceRecovery(spec:{token:string;allowGaps:boolean}): Promise<{ok:boolean;error?:string;audioPath?:string;reportPath?:string;duration?:number;count?:number;missing?:number[]}>;
      onScriptStudioProgress(cb: (p: Record<string, unknown>) => void): () => void;
      cancelVoiceEdit():Promise<boolean>;
      onVoiceEditProgress(cb:(p:Record<string,unknown>)=>void):()=>void;
      recapStatus(): Promise<{downloader:boolean;running:boolean}>;
      setupRecapDownloader(): Promise<{ok:boolean;error?:string}>;
      cancelFastRecap(): Promise<boolean>;
      runFastRecap(spec: FastRecapSpec): Promise<FastRecapResult>;
      onRecapProgress(cb:(p:Record<string,unknown>)=>void):()=>void;
      readSettings(): Promise<AppSettings>;
      updateSettings(patch: Record<string, unknown>): Promise<AppSettings>;
      getAvailableFonts(): Promise<FontCatalog>;
      importCustomFonts(): Promise<{ canceled: boolean; imported?: string[]; fonts: FontCatalog }>;

      whisperStatus(): Promise<{
        available: boolean;
        binary: string | null;
        models: { id: string; label: string; mb: number; note: string; installed: boolean }[];
      }>;
      downloadWhisperModel(model: string): Promise<string>;
      cancelCaptionAlignment(): Promise<boolean>;
      onWhisperProgress(cb: (p: { model: string; pct: number }) => void): () => void;

      transcribe(spec: { mediaPath: string; model: string; language: string }): Promise<
        { ok: true; segments: DubSegment[]; language: string } | { ok: false; error: string }
      >;
      openSubtitles(): Promise<
        { ok: true; segments: DubSegment[] } | { ok: false; error?: string; canceled?: boolean }
      >;
      autosaveDub(payload: DubSession): Promise<boolean>;
      restoreDub(): Promise<(DubSession & { savedAt?: string }) | null>;
      saveDubAs(payload: DubSession): Promise<{ ok: boolean; path?: string | null; error?: string }>;
      openDubFrom(): Promise<
        { ok: true; data: DubSession } | { ok: false; error?: string; canceled?: boolean }
      >;
      exportDubSrt(segments: DubSegment[]): Promise<{ ok: boolean; path?: string | null; error?: string }>;

      translateProviders(): Promise<TranslateProvider[]>;
      translateModels(providerId: string): Promise<
        { ok: true; models: string[] } | { ok: false; error: string }
      >;
      translateSegments(spec: {
        segments: DubSegment[];
        language: string;
        providerId: string;
        model: string;
      }): Promise<{ ok: true; segments: DubSegment[] } | { ok: false; error: string }>;
      synthesizeDub(spec: {
        segments: DubSegment[];
        options: {
          providerId: string;
          voiceId: string;
          modelId: string;
          stability?: number;
          similarity?: number;
          /** Fastest a line may be sped up to fit its slot. */
          maxTempo?: number;
        };
      }): Promise<{ ok: true; jobId: string; dir: string; clips: DubClip[] } | { ok: false; error: string }>;
      onDubProgress(cb: (p: Record<string, unknown> & { stage: string }) => void): () => void;

      voiceProviders(): Promise<VoiceProvider[]>;
      listVoices(providerId: string): Promise<{ ok: true; voices: Voice[] } | { ok: false; error: string }>;
      listTtsModels(providerId: string): Promise<
        { ok: true; models: VoiceProvider['models'] } | { ok: false; error: string }
      >;
      voiceQuota(providerId: string): Promise<{
        ok: true;
        quota: { tier: string; used: number; limit: number } | null;
      }>;

      initialMedia(): Promise<string[]>;
      openMedia(): Promise<string[]>;
      probe(filePath: string): Promise<{
        duration: number; width: number; height: number; fps: number;
        hasVideo: boolean; hasAudio: boolean; kind: string;
      }>;
      thumbnails(filePath: string, duration: number, count?: number): Promise<string[]>;
      waveform(filePath: string): Promise<WaveformData>;
      clipThumbnails(filePath: string, timestamps: number[]): Promise<{ ok: boolean; paths: string[]; error?: string }>;
      extractFreezeFrame(spec: { videoPath: string; timestamp: number }): Promise<{ ok: boolean; imagePath?: string; error?: string }>;
      sceneDetect(filePath: string, threshold?: number): Promise<{ ok: boolean; cuts: number[]; error?: string }>;
      saveExportDialog(defaultName?: string): Promise<string | null>;
      runExport(spec: ExportSpec): Promise<{ ok: boolean; path?: string; error?: string }>;
      detectEncoders(): Promise<{ h264?: string; hevc?: string; av1?: string }>;
      selectExportFolder(defaultDir?: string): Promise<string | null>;
      cancelExport(): Promise<boolean>;
      openExportPath(filePath: string): Promise<void>;
      getDefaultExportDir(): Promise<string>;
      onExportProgress(cb: (info: any) => void): () => void;
      showItemInFolder(p: string): Promise<void>;
      minimize(): Promise<void>;
      toggleMaximize(): Promise<boolean>;
      openSrtFile(): Promise<{ ok: boolean; path?: string; name?: string; entriesCount?: number; error?: string } | null>;
      openTxtFile(): Promise<{ ok: boolean; path?: string; name?: string; text?: string; error?: string } | null>;
      openAudioFileDialog(): Promise<{ ok: boolean; path?: string; name?: string; duration?: number; hasAudio?: boolean; error?: string } | null>;
      alignAudioScript(spec: {
        whisperModel?: string;
        audioPath: string;
        scriptText?: string;
        srtPath?: string;
        minSilence?: number;
        noise?: string;
        useWhisper?: boolean;
        mode?: 'auto' | 'whisper' | 'fast' | 'script_captions';
      }): Promise<{
        ok: boolean;
        audioDuration?: number;
        sentenceCount?: number;
        method?: string;
        segments?: Array<{
          id: number;
          index: number;
          text: string;
          start: number;
          end: number;
          duration: number;
        }>;
        error?: string;
      }>;
      onVoiceAlignProgress(cb: (info: any) => void): () => void;
      syncTimelineSrt(spec: {
        videoPath: string;
        srtPath?: string;
        srtContent?: string;
        voicePath: string;
        voiceOffset?: number;
        voiceDuration?: number;
        scriptText?: string;
        scriptPath?: string;
        videoOffset?: number;
        pacingMode?: 'freeze' | 'motion' | 'hybrid';
        geminiApiKey?: string;
      }): Promise<{ ok: boolean; cuts?: any[]; nextSourceOffset?: number; error?: string }>;
      autoCutBySrt(spec: {
        srtPath: string;
        srtContent?: string;
        captions: Clip[];
        projectData: ProjectDocument;
        videoMediaId?: string;
        requestId?: string;
      }): Promise<RecapCutResult>;
      onRecapCutProgress(cb: (p: { stage?: string; message?: string; requestId?: string }) => void): () => void;
      syncTimelineVoice(spec: any): Promise<any>;
      onVoiceEditProgress(cb: (p: any) => void): () => void;
      toMediaUrl(filePath: string): string;
    };
  }
}

export interface FastRecapSpec {
  source?: string;
  url?: string;
  segments?: DubSegment[];
  sourceLanguage: string;
  whisperModel: string;
  language: string;
  glossary: string;
  concurrency: number;
  characterBudget: number;
  translation: {providerId:string;model:string};
  voice: {providerId:string;voiceId:string;modelId:string;maxTempo:number};
}
export interface FastRecapResult {
  ok:boolean;
  canceled?:boolean;
  error?:string;
  status?:string;
  path?:string;
  projectPath?:string;
  transcriptPath?:string;
  srtPath?:string;
  reportPath?:string;
  totalElapsedSeconds?:number;
  reservedCharacters?:number;
  cached?:number;
  targetMet?:boolean;
  issues?:{id:number;start:number;overflow:number;text:string}[];
}

export interface VoiceEditRow {
  id:number;sourceStart:number;sourceEnd:number;targetStart:number;targetEnd:number;
  text:string;confidence:number;review:boolean;
}
export interface VoiceEditResult {
  ok:boolean;error?:string;jobId?:string;dir?:string;source?:string;voice?:string;
  videoDuration?:number;voiceDuration?:number;plan?:VoiceEditRow[];projectPath?:string;isSilent?:boolean;prepareSeconds?:number;
}

export interface ScriptStudioSpec {
  scriptText: string;
  voiceId: string;
  modelId?: string;
  stability?: number;
  similarity?: number;
  speed?: number;
  videoPath?: string;
  sourceOffset?: number;
  geminiModel?: string;
  mode?: 'hybrid' | 'freeze' | 'cut' | 'audio_only';
  audioOnly?: boolean;
  useVision?: boolean;
  panelPacing?: 'auto' | number;
}

export interface ScriptStudioResult {
  ok: boolean;
  error?: string;
  audioPath?: string;
  voiceDuration?: number;
  videoDuration?: number;
  cuts?: {
    id: number;
    sourceStart: number;
    sourceEnd: number;
    targetStart: number;
    targetEnd: number;
    duration: number;
    text?: string;
    reason?: string;
    freeze?: boolean;
    freezeImagePath?: string;
  }[];
  sentences?: {
    id: number;
    text: string;
    start: number;
    end: number;
  }[];
  nextSourceOffset?: number;
  visionAIUsed?: boolean;
  visionError?: string;
}
