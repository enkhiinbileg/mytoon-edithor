export interface AlignOptions {
  mode?: 'auto' | 'full' | 'selected';
  selectedClipId?: string | null;
  selectedClipIds?: string[];
}

export interface AlignResult<T> {
  updatedClips: T[];
  updatedCount: number;
  matchedRange?: { start: number; end: number };
  modeUsed: 'auto' | 'full' | 'selected';
  message: string;
}

export interface AutoTagRule {
  tag: string;
  label: string;
  icon: string;
  pattern: RegExp;
  dialoguePunc?: RegExp;
  category: 'reaction' | 'emotion' | 'tone';
  priority: number;
}

export interface AutoTagOptions {
  intensity?: 'balanced' | 'dramatic';
  clearExisting?: boolean;
}

export interface AutoTagResult {
  text: string;
  tagsAdded: number;
  breakdown: Record<string, number>;
  details: { tag: string; snippet: string }[];
}

export function normalizeWord(w: string): string;
export function phoneticNormalize(w: string): string;
export function wordSimilarity(w1: string, w2: string): number;

export function reflowSentenceBoundaries<T extends { id: string; style?: { text?: string }; text?: string }>(
  clips: T[]
): { updatedClips: T[]; fixedCount: number };

export function alignScriptToClips<T extends { id: string; style?: { text?: string }; text?: string }>(
  scriptText: string,
  clips: T[],
  options?: AlignOptions
): AlignResult<T>;

export function layoutCaptions<T extends { text: string; start: number; duration: number }>(
  segments: T[]
): T[];

export const AUTO_TAG_RULES: AutoTagRule[];
export function clearTagsFromScript(text: string): { text: string; removedCount: number };
export function countTagsInScript(text: string): number;
export function autoTagMongolianScript(rawScript: string, options?: AutoTagOptions): AutoTagResult;
