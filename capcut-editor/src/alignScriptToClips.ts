'use strict';

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

/**
 * Normalizes a word for fuzzy matching (lowercase, removes punctuation).
 * Supports both Mongolian Cyrillic and Latin alphabets.
 */
export function normalizeWord(w: string): string {
  return String(w || '')
    .toLowerCase()
    .replace(/[^a-zа-яёөү\d]/gi, '');
}

/**
 * Calculates similarity between two words (0.0 to 1.0) using Levenshtein distance.
 */
export function wordSimilarity(w1: string, w2: string): number {
  const s1 = normalizeWord(w1);
  const s2 = normalizeWord(w2);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;
  if (s1.includes(s2) || s2.includes(s1)) {
    const minL = Math.min(s1.length, s2.length);
    const maxL = Math.max(s1.length, s2.length);
    return minL / maxL;
  }

  const m = s1.length;
  const n = s2.length;
  if (Math.abs(m - n) > 3) return 0;

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

interface CandidateMatch {
  sIdx: number;
  aIdx: number;
  score: number;
}

/**
 * Finds the Longest Increasing Subsequence (LIS) of anchor matches.
 * Enforces monotonic forward time progression.
 */
function findAnchorSequence(candidates: CandidateMatch[]): CandidateMatch[] {
  if (!candidates.length) return [];
  candidates.sort((a, b) => a.sIdx - b.sIdx || a.aIdx - b.aIdx);

  const n = candidates.length;
  const dp = new Float64Array(n);
  const parent = new Int32Array(n).fill(-1);

  let bestIdx = 0;
  let maxScore = 0;

  for (let i = 0; i < n; i++) {
    const c_i = candidates[i];
    dp[i] = c_i.score;
    const lookbackStart = Math.max(0, i - 250);
    for (let j = i - 1; j >= lookbackStart; j--) {
      const c_j = candidates[j];
      if (c_j.sIdx < c_i.sIdx && c_j.aIdx < c_i.aIdx) {
        const sDiff = c_i.sIdx - c_j.sIdx;
        const aDiff = c_i.aIdx - c_j.aIdx;
        const ratio = sDiff / Math.max(1, aDiff);
        const distPenalty = Math.abs(ratio - 1.0) * 0.2;
        const score = dp[j] + c_i.score - distPenalty;

        if (score > dp[i]) {
          dp[i] = score;
          parent[i] = j;
        }
      }
    }
    if (dp[i] > maxScore) {
      maxScore = dp[i];
      bestIdx = i;
    }
  }

  const sequence: CandidateMatch[] = [];
  let curr = bestIdx;
  while (curr !== -1) {
    sequence.push(candidates[curr]);
    curr = parent[curr];
  }
  sequence.reverse();
  return sequence;
}

/**
 * Searches timeline clips to find the best matching contiguous window
 * for a partial script.
 */
function findBestClipWindow<T extends { id: string; style?: { text?: string }; text?: string }>(
  scriptWords: string[],
  clips: T[]
): { start: number; end: number; score: number } | null {
  if (!scriptWords.length || !clips.length) return null;

  const targetWordCount = scriptWords.length;
  const scriptNormSet = new Set(scriptWords.map(normalizeWord).filter(w => w.length >= 3));
  if (scriptNormSet.size === 0) return null;

  const clipData = clips.map(c => {
    const t = c.style?.text || c.text || '';
    const words = t.match(/\S+/gu) || [];
    const norms = words.map(normalizeWord).filter(w => w.length >= 3);
    return { count: words.length, norms };
  });

  let bestStart = -1;
  let bestEnd = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < clips.length; i++) {
    let accumulatedWords = 0;
    let overlapCount = 0;
    let j = i;

    while (j < clips.length && accumulatedWords < targetWordCount * 1.35) {
      accumulatedWords += Math.max(1, clipData[j].count);
      for (const nw of clipData[j].norms) {
        if (scriptNormSet.has(nw)) {
          overlapCount++;
        }
      }

      if (accumulatedWords >= targetWordCount * 0.6) {
        const lenDiff = Math.abs(accumulatedWords - targetWordCount);
        const score = (overlapCount * 3.0) - (lenDiff * 0.4);
        if (overlapCount >= 2 && score > bestScore) {
          bestScore = score;
          bestStart = i;
          bestEnd = j;
        }
      }
      j++;
    }
  }

  if (bestStart !== -1 && bestEnd !== -1) {
    return { start: bestStart, end: bestEnd, score: bestScore };
  }
  return null;
}

/**
 * Core word-to-clip alignment algorithm.
 * Guarantees zero blank clips and preserves timestamps.
 */
function alignWordsToTargetClips<T extends { id: string; start?: number; inPoint?: number; outPoint?: number; style?: { text?: string }; text?: string }>(
  scriptWords: string[],
  targetClips: T[]
): T[] {
  if (!scriptWords.length || !targetClips.length) return targetClips;

  interface AsrWord {
    clipIdx: number;
    wordIdx: number;
    orig: string;
    norm: string;
    time: number;
  }

  const asrWords: AsrWord[] = [];
  targetClips.forEach((clip, clipIdx) => {
    const text = clip.style?.text || clip.text || '';
    const words = text.match(/\S+/gu) || [];
    const clipStart = typeof clip.start === 'number' ? clip.start : (clipIdx * 2.0);
    words.forEach((w, wordIdx) => {
      asrWords.push({
        clipIdx,
        wordIdx,
        orig: w,
        norm: normalizeWord(w),
        time: clipStart
      });
    });
  });

  if (!asrWords.length) {
    const wordsPerClip = Math.ceil(scriptWords.length / targetClips.length);
    return targetClips.map((clip, i) => {
      const slice = scriptWords.slice(i * wordsPerClip, (i + 1) * wordsPerClip);
      const newText = slice.join(' ');
      return {
        ...clip,
        text: newText,
        style: clip.style ? { ...clip.style, text: newText } : ({ text: newText } as any)
      };
    });
  }

  // 1. Monotonic forward anchor discovery bounded by physical speech rate (max ~4.2 words/sec)
  let sCur = 0;
  let lastAnchorTime = asrWords[0].time;
  interface Anchor {
    sIdx: number;
    aIdx: number;
    clipIdx: number;
    time: number;
  }
  const anchors: Anchor[] = [];

  for (let a = 0; a < asrWords.length; a++) {
    const aw = asrWords[a];
    if (!aw.norm || aw.norm.length < 3) continue;

    const deltaTime = Math.max(0, aw.time - lastAnchorTime);
    const maxWordsAllowed = Math.max(12, Math.round(deltaTime * 4.2) + 6);
    const maxLookahead = Math.min(scriptWords.length - 1, sCur + maxWordsAllowed);

    let bestS = -1;
    let bestSim = 0;

    for (let s = sCur; s <= maxLookahead; s++) {
      const swNorm = normalizeWord(scriptWords[s]);
      if (!swNorm) continue;

      if (swNorm === aw.norm) {
        bestS = s;
        bestSim = 1.0;
        break;
      }
      const sim = wordSimilarity(swNorm, aw.norm);
      if (sim >= 0.85 && sim > bestSim) {
        bestSim = sim;
        bestS = s;
      }
    }

    if (bestS !== -1 && bestSim >= 0.85) {
      anchors.push({ sIdx: bestS, aIdx: a, clipIdx: aw.clipIdx, time: aw.time });
      sCur = bestS + 1;
      lastAnchorTime = aw.time;
    }
  }

  if (anchors.length === 0) return targetClips;

  // 2. Precompute clip weights based on clip duration and recognized words
  const clipWeights = targetClips.map(c => {
    const dur = typeof c.outPoint === 'number' && typeof c.inPoint === 'number'
      ? Math.max(0.5, c.outPoint - c.inPoint)
      : 2.0;
    const wCount = (c.style?.text || c.text || '').match(/\S+/gu)?.length || 0;
    return Math.max(1, wCount > 0 ? wCount : Math.round(dur * 2.8));
  });

  const clipAlloc: string[][] = new Array(targetClips.length).fill(null).map(() => []);

  function distributeSlice(sStart: number, sEnd: number, cStart: number, cEnd: number) {
    if (sStart > sEnd || cStart > cEnd) return;
    const words = scriptWords.slice(sStart, sEnd + 1);
    if (!words.length) return;

    if (cStart === cEnd) {
      clipAlloc[cStart].push(...words);
      return;
    }

    let totalW = 0;
    for (let c = cStart; c <= cEnd; c++) totalW += clipWeights[c];
    if (totalW <= 0) totalW = cEnd - cStart + 1;

    let wIdx = 0;
    for (let c = cStart; c <= cEnd; c++) {
      const isLast = (c === cEnd);
      const clipW = clipWeights[c];
      const take = isLast
        ? (words.length - wIdx)
        : Math.min(words.length - wIdx, Math.round((clipW / totalW) * words.length));

      if (take > 0) {
        clipAlloc[c].push(...words.slice(wIdx, wIdx + take));
        wIdx += take;
      }
    }
  }

  // A. Distribute words before first anchor:
  const firstA = anchors[0];
  if (firstA.sIdx > 0 && firstA.clipIdx > 0) {
    distributeSlice(0, firstA.sIdx - 1, 0, firstA.clipIdx - 1);
  }
  clipAlloc[firstA.clipIdx].push(scriptWords[firstA.sIdx]);

  // B. Distribute words between consecutive anchors:
  for (let k = 0; k < anchors.length - 1; k++) {
    const a1 = anchors[k];
    const a2 = anchors[k + 1];
    const sStart = a1.sIdx + 1;
    const sEnd = a2.sIdx - 1;

    if (sStart <= sEnd) {
      distributeSlice(sStart, sEnd, a1.clipIdx, a2.clipIdx);
    }
    clipAlloc[a2.clipIdx].push(scriptWords[a2.sIdx]);
  }

  // C. Distribute words after last anchor (only up to timeline capacity):
  const lastA = anchors[anchors.length - 1];
  const remClips = targetClips.length - 1 - lastA.clipIdx;
  if (remClips > 0) {
    let remWeight = 0;
    for (let c = lastA.clipIdx + 1; c < targetClips.length; c++) remWeight += clipWeights[c];
    const wordsToTake = Math.min(scriptWords.length - 1 - lastA.sIdx, remWeight);
    if (wordsToTake > 0) {
      distributeSlice(lastA.sIdx + 1, lastA.sIdx + wordsToTake, lastA.clipIdx + 1, targetClips.length - 1);
    }
  }

  // 3. Balance words across adjacent clips so no single clip exceeds comfortable reading length (<= 7 words)
  const MAX_WORDS = 7;
  for (let pass = 0; pass < 3; pass++) {
    for (let c = 0; c < targetClips.length - 1; c++) {
      if (clipAlloc[c].length > MAX_WORDS) {
        const excess = clipAlloc[c].length - MAX_WORDS;
        const moved = clipAlloc[c].splice(clipAlloc[c].length - excess, excess);
        clipAlloc[c + 1].unshift(...moved);
      }
    }
  }

  // 4. Build updated clips (Keep original text for any clip with 0 assigned words)
  const rawUpdated = targetClips.map((clip, idx) => {
    const assigned = clipAlloc[idx];
    const newText = (assigned && assigned.length > 0)
      ? assigned.join(' ')
      : (clip.style?.text || clip.text || '');

    return {
      ...clip,
      text: newText,
      style: clip.style ? { ...clip.style, text: newText } : ({ text: newText } as any)
    };
  });

  return reflowSentenceBoundaries(rawUpdated).updatedClips;
}

/**
 * Reflows sentence boundaries between subtitle clips so that sentence endings (. ! ? ...)
 * never spill over into the next clip, and new sentences never start prematurely at the end of a clip.
 */
export function reflowSentenceBoundaries<T extends { id: string; style?: { text?: string }; text?: string }>(
  clips: T[]
): { updatedClips: T[]; fixedCount: number } {
  if (!clips || clips.length < 2) return { updatedClips: clips, fixedCount: 0 };

  const result: T[] = clips.map(c => ({
    ...c,
    style: c.style ? { ...c.style } : undefined
  }));

  const isTerminal = (w: string) => /[.!?…]["'»”’)]?$/.test(w || '');
  const isCapitalized = (w: string) => /^[А-ЯЁӨҮA-Z]/.test((w || '').replace(/^["'«“‘(]/, ''));

  let fixedCount = 0;

  for (let pass = 0; pass < 3; pass++) {
    let passChanged = false;

    for (let i = 0; i < result.length - 1; i++) {
      const cur = result[i];
      const next = result[i + 1];

      const curText = (cur.style?.text || cur.text || '').trim();
      const nextText = (next.style?.text || next.text || '').trim();

      if (!curText || !nextText) continue;

      const curWords = curText.split(/\s+/).filter(Boolean);
      const nextWords = nextText.split(/\s+/).filter(Boolean);

      // Case 1: Next clip starts with 1 terminal word from the previous sentence (e.g. "яддаг.")
      if (nextWords.length > 1 && isTerminal(nextWords[0])) {
        const movedWord = nextWords.shift()!;
        curWords.push(movedWord);
        passChanged = true;
        fixedCount++;
      }
      // Case 1b: Next clip starts with 2 short words where 2nd is terminal and curWords has no terminal
      else if (nextWords.length > 2 && isTerminal(nextWords[1]) && !isTerminal(curWords[curWords.length - 1])) {
        const w0 = nextWords.shift()!;
        const w1 = nextWords.shift()!;
        curWords.push(w0, w1);
        passChanged = true;
        fixedCount++;
      }

      // Case 2: Current clip ends with a terminal word followed by a single capitalized start-word (e.g. "муу. Гэтэл")
      if (curWords.length > 2) {
        const lastWord = curWords[curWords.length - 1];
        const secondLast = curWords[curWords.length - 2];
        if (isTerminal(secondLast) && !isTerminal(lastWord) && isCapitalized(lastWord)) {
          const movedWord = curWords.pop()!;
          nextWords.unshift(movedWord);
          passChanged = true;
          fixedCount++;
        }
      }

      const newCurText = curWords.join(' ');
      const newNextText = nextWords.join(' ');

      if (cur.style) cur.style.text = newCurText;
      cur.text = newCurText;

      if (next.style) next.style.text = newNextText;
      next.text = newNextText;
    }

    if (!passChanged) break;
  }

  return { updatedClips: result, fixedCount };
}

/**
 * Aligns clean script words to subtitle clips.
 * Replaces misspelled ASR words with clean script text while preserving exact timestamps.
 * 
 * Automatically detects whether the pasted text is a partial snippet or full script,
 * or allows targeting selected clips.
 */
export function alignScriptToClips<T extends { id: string; style?: { text?: string }; text?: string }>(
  scriptText: string,
  clips: T[],
  options: AlignOptions = {}
): AlignResult<T> {
  const rawWords = scriptText.match(/\S+/gu) || [];
  if (!rawWords.length || !clips.length) {
    return {
      updatedClips: clips,
      updatedCount: 0,
      modeUsed: options.mode || 'auto',
      message: 'Засах текст эсвэл хадмал олдсонгүй.'
    };
  }

  const requestedMode = options.mode || 'auto';

  // 1. Selected Clips Mode
  if (requestedMode === 'selected' || (options.selectedClipId && requestedMode !== 'full')) {
    const selId = options.selectedClipId;
    const selIdx = clips.findIndex(c => c.id === selId);

    if (selIdx !== -1) {
      // Calculate how many clips this text should span
      const wordsPerClipAvg = 5;
      const spanCount = Math.max(1, Math.ceil(rawWords.length / wordsPerClipAvg));
      const endIdx = Math.min(clips.length - 1, selIdx + spanCount - 1);
      const targetSlice = clips.slice(selIdx, endIdx + 1);

      const alignedSlice = alignWordsToTargetClips(rawWords, targetSlice);
      const sliceMap = new Map(alignedSlice.map(c => [c.id, c]));

      const updatedClips = clips.map(c => sliceMap.get(c.id) || c);
      const finalClips = reflowSentenceBoundaries(updatedClips).updatedClips;

      return {
        updatedClips: finalClips,
        updatedCount: targetSlice.length,
        matchedRange: { start: selIdx, end: endIdx },
        modeUsed: 'selected',
        message: `Сонгосон #${selIdx + 1}-ээс #${endIdx + 1} хүртэлх ${targetSlice.length} хадмалыг скриптээр заслаа.`
      };
    }
  }

  // Count total words on timeline
  let totalTimelineWords = 0;
  for (const c of clips) {
    const t = c.style?.text || c.text || '';
    totalTimelineWords += (t.match(/\S+/gu) || []).length;
  }

  // 2. Auto Mode: Check if this is a partial snippet (< 45% of total words and >= 8 clips)
  const isPartial = requestedMode === 'auto' && rawWords.length < Math.max(15, totalTimelineWords * 0.45) && clips.length >= 6;

  if (isPartial) {
    const windowFound = findBestClipWindow(rawWords, clips);
    if (windowFound && (windowFound.score > 5 || windowFound.end - windowFound.start >= 1)) {
      const targetSlice = clips.slice(windowFound.start, windowFound.end + 1);
      const alignedSlice = alignWordsToTargetClips(rawWords, targetSlice);
      const sliceMap = new Map(alignedSlice.map(c => [c.id, c]));

      const updatedClips = clips.map(c => sliceMap.get(c.id) || c);
      const finalClips = reflowSentenceBoundaries(updatedClips).updatedClips;

      return {
        updatedClips: finalClips,
        updatedCount: targetSlice.length,
        matchedRange: { start: windowFound.start, end: windowFound.end },
        modeUsed: 'auto',
        message: `Таарсан #${windowFound.start + 1}-ээс #${windowFound.end + 1} хүртэлх ${targetSlice.length} хадмалыг скриптээр заслаа.`
      };
    }
  }

  // 3. Full Script Mode: Align across all clips
  const alignedAll = alignWordsToTargetClips(rawWords, clips);
  const finalAll = reflowSentenceBoundaries(alignedAll).updatedClips;

  return {
    updatedClips: finalAll,
    updatedCount: clips.length,
    matchedRange: { start: 0, end: clips.length - 1 },
    modeUsed: 'full',
    message: `Нийт ${clips.length} хадмалыг бүрэн зохиолоор амжилттай заслаа.`
  };
}
