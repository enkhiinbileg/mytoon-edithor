'use strict';

/**
 * Normalizes a word for fuzzy matching (lowercase, removes punctuation).
 */
export function normalizeWord(w: string): string {
  return String(w || '').toLowerCase().replace(/[^a-zа-яёөү\d]/gi, '');
}

/**
 * Calculates similarity between two words (0.0 to 1.0) using Levenshtein distance.
 */
export function wordSimilarity(w1: string, w2: string): number {
  const s1 = normalizeWord(w1);
  const s2 = normalizeWord(w2);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;
  if (s1.includes(s2) || s2.includes(s1)) return 0.85;

  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  const maxLen = Math.max(m, n);
  return Math.max(0, 1 - dp[m][n] / maxLen);
}

/**
 * Aligns clean script words to subtitle clips, replacing misspelled ASR words
 * with clean script text while preserving exact timestamps.
 */
export function alignScriptToClips<T extends { id: string; style?: { text?: string }; text?: string }>(
  scriptText: string,
  clips: T[]
): T[] {
  const rawWords = scriptText.match(/\S+/gu) || [];
  if (!rawWords.length || !clips.length) return clips;

  let scriptCursor = 0;
  const updated: T[] = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const isLast = i === clips.length - 1;
    const existingText = clip.style?.text || clip.text || '';
    const clipWords = existingText.match(/\S+/gu) || [];
    const clipWordCount = Math.max(1, clipWords.length);

    if (isLast) {
      const remaining = rawWords.slice(scriptCursor).join(' ');
      const newText = remaining || existingText;
      updated.push({
        ...clip,
        text: newText,
        style: clip.style ? { ...clip.style, text: newText } : undefined
      });
      break;
    }

    const expectedEnd = scriptCursor + clipWordCount;
    const windowStart = Math.max(scriptCursor + 1, expectedEnd - 6);
    const windowEnd = Math.min(rawWords.length, expectedEnd + 10);

    const lastClipWord = clipWords[clipWords.length - 1] || '';
    let bestEnd = expectedEnd;
    let bestScore = -1;

    for (let candidate = windowStart; candidate <= windowEnd; candidate++) {
      const scriptWord = rawWords[candidate - 1];
      const sim = wordSimilarity(lastClipWord, scriptWord);
      const driftCost = Math.abs(candidate - expectedEnd) * 0.05;
      const score = sim - driftCost;
      if (score > bestScore) {
        bestScore = score;
        bestEnd = candidate;
      }
    }

    // Punctuation snap: if the word right after has punctuation (.,!?) or is a particle, include it
    if (bestEnd < rawWords.length) {
      if (!/[.!?,]$/.test(rawWords[bestEnd - 1]) && /[.!?,]$/.test(rawWords[bestEnd])) {
        bestEnd += 1;
      }
    }

    bestEnd = Math.max(scriptCursor + 1, Math.min(rawWords.length, bestEnd));
    const matchedText = rawWords.slice(scriptCursor, bestEnd).join(' ');

    updated.push({
      ...clip,
      text: matchedText,
      style: clip.style ? { ...clip.style, text: matchedText } : undefined
    });
    scriptCursor = bestEnd;
  }

  return updated;
}
