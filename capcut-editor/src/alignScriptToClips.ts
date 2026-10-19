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

const LatinToCyrMap: ReadonlyArray< readonly [string, string] > = [
  ['sh', 'ш'], ['ch', 'ч'], ['ts', 'ц'], ['kh', 'х'], ['zh', 'ж'],
  ['ya', 'я'], ['yu', 'ю'], ['yo', 'ё'], ['ye', 'е'],
  ['a', 'а'], ['b', 'б'], ['c', 'к'], ['d', 'д'], ['e', 'э'],
  ['f', 'ф'], ['g', 'г'], ['h', 'х'], ['i', 'и'], ['j', 'ж'],
  ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'],
  ['p', 'п'], ['q', 'к'], ['r', 'р'], ['s', 'с'], ['t', 'т'],
  ['u', 'у'], ['v', 'в'], ['w', 'в'], ['x', 'кс'], ['y', 'и'], ['z', 'з']
];

const DigitWordMap: Record<string, string> = {
  '1': 'нэг',
  '2': 'хоёр',
  '3': 'гурав',
  '4': 'дөрөв',
  '5': 'тав',
  '6': 'зургаа',
  '7': 'долоо',
  '8': 'найм',
  '9': 'ес',
  '10': 'арав',
  '12': 'арванхоёр',
  '30': 'гуч',
  '40': 'дөч',
  '150': 'зуунтавь'
};

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
 * Phonetic normalization for Mongolian ASR matching:
 * maps numbers to spoken stems, transliterates Latin to Cyrillic,
 * and collapses commonly confused vowels/consonants.
 */
export function phoneticNormalize(w: string): string {
  let s = normalizeWord(w);
  if (!s) return '';
  if (DigitWordMap[s]) s = DigitWordMap[s];
  if (/[a-z]/.test(s)) {
    for (const [lat, cyr] of LatinToCyrMap) {
      s = s.split(lat).join(cyr);
    }
  }
  return s
    .replace(/[өүо]/g, 'у')
    .replace(/ё/g, 'е')
    .replace(/я/g, 'а')
    .replace(/[эыій]/g, 'и')
    .replace(/[ъь]/g, '')
    .replace(/([а-яёөү])\1+/g, '$1');
}

const EDIT_DP_BUF = new Int32Array(64 * 64);

function editDistanceSimilarity(s1: string, s2: string): number {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;
  const m = s1.length;
  const n = s2.length;
  const maxLen = m > n ? m : n;
  const maxDist = Math.floor(maxLen * 0.5);
  if (Math.abs(m - n) > maxDist || m >= 63 || n >= 63) return 0;

  const stride = n + 1;
  for (let j = 0; j <= n; j++) EDIT_DP_BUF[j] = j;

  for (let i = 1; i <= m; i++) {
    const c1 = s1.charCodeAt(i - 1);
    const rowOff = i * stride;
    const prevOff = (i - 1) * stride;
    EDIT_DP_BUF[rowOff] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = c1 === s2.charCodeAt(j - 1) ? 0 : 1;
      const del = EDIT_DP_BUF[prevOff + j] + 1;
      const ins = EDIT_DP_BUF[rowOff + (j - 1)] + 1;
      const sub = EDIT_DP_BUF[prevOff + (j - 1)] + cost;
      const val = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
      EDIT_DP_BUF[rowOff + j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return 0;
  }

  const dist = EDIT_DP_BUF[m * stride + n];
  return Math.max(0, 1 - dist / maxLen);
}

function fastTokenSimilarity(n1: string, p1: string, n2: string, p2: string): number {
  if (!n1 || !n2) return 0;
  if (n1 === n2) return 1.0;
  if (p1 && p1 === p2) return 0.95;

  const rawSim = editDistanceSimilarity(n1, n2);
  const phonSim = p1 && p2 ? editDistanceSimilarity(p1, p2) * 0.95 : 0;

  let prefixSim = 0;
  const minL = Math.min(p1.length, p2.length);
  const maxL = Math.max(p1.length, p2.length);
  if (minL >= 4 && p1.charCodeAt(0) === p2.charCodeAt(0)) {
    let common = 0;
    while (common < minL && p1.charCodeAt(common) === p2.charCodeAt(common)) common++;
    if (common >= 4) {
      prefixSim = Math.min(0.88, common / maxL + 0.15);
    }
  }

  return Math.max(rawSim, phonSim, prefixSim);
}

/**
 * Calculates similarity between two words (0.0 to 1.0) using Levenshtein and Mongolian phonetic distance.
 */
export function wordSimilarity(w1: string, w2: string): number {
  const n1 = normalizeWord(w1);
  const n2 = normalizeWord(w2);
  if (!n1 || !n2) return 0;
  if (n1 === n2) return 1.0;
  return fastTokenSimilarity(n1, phoneticNormalize(w1), n2, phoneticNormalize(w2));
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
  const scriptPhonSet = new Set(scriptWords.map(phoneticNormalize).filter(w => w.length >= 3));
  if (scriptPhonSet.size === 0) return null;

  const clipData = clips.map(c => {
    const t = c.style?.text || c.text || '';
    const words = t.match(/\S+/gu) || [];
    const phons = words.map(phoneticNormalize).filter(w => w.length >= 3);
    return { count: words.length, phons };
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
      for (const pw of clipData[j].phons) {
        if (scriptPhonSet.has(pw)) {
          overlapCount++;
        }
      }

      if (accumulatedWords >= targetWordCount * 0.6) {
        const lenDiff = Math.abs(accumulatedWords - targetWordCount);
        const score = overlapCount * 3.0 - lenDiff * 0.4;
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

interface Anchor {
  sIdx: number;
  aIdx: number;
  clipIdx: number;
  sim: number;
}

interface TokenInfo {
  orig: string;
  norm: string;
  phon: string;
}

interface AsrWord extends TokenInfo {
  clipIdx: number;
  wordIdx: number;
  time: number;
}

/**
 * Detects and heals regions where Whisper chunk boundaries duplicated a spoken passage:
 * re-anchors the second (true-time) duplicate copy and allows preceding script words
 * to distribute evenly across the first half.
 */
function healShiftedDuplicateRegions(
  anchors: Anchor[],
  scriptTokens: TokenInfo[],
  asrWords: AsrWord[]
): Anchor[] {
  const result = anchors.slice();
  for (let k1 = 0; k1 < result.length - 1; k1++) {
    const a1 = result[k1];
    const a2 = result[k1 + 1];
    const ds1 = a2.sIdx - a1.sIdx;
    const da1 = a2.aIdx - a1.aIdx;
    if (ds1 - da1 >= 8 && ds1 >= da1 * 2.5) {
      let k2 = -1;
      let cumDs = 0;
      let cumDa = 0;
      const limit = Math.min(result.length - 1, k1 + 45);
      for (let m = k1 + 1; m < limit; m++) {
        cumDs += result[m + 1].sIdx - result[m].sIdx;
        cumDa += result[m + 1].aIdx - result[m].aIdx;
        if (cumDa - cumDs >= 8) {
          k2 = m + 1;
        }
      }
      if (k2 !== -1) {
        const startAnchor = result[k1];
        const endAnchor = result[k2];
        const reAnchored: Anchor[] = [];
        let curA = endAnchor.aIdx;
        let misses = 0;
        for (let s = endAnchor.sIdx - 1; s > startAnchor.sIdx; s--) {
          const st = scriptTokens[s];
          let bestA = -1;
          let bestSim = 0;
          const minA = Math.max(startAnchor.aIdx + 1, curA - 2);
          for (let a = curA - 1; a >= minA; a--) {
            const aw = asrWords[a];
            const sim = fastTokenSimilarity(st.norm, st.phon, aw.norm, aw.phon);
            if (sim >= 0.70 && sim > bestSim) {
              bestSim = sim;
              bestA = a;
              if (sim >= 0.92) break;
            }
          }
          if (bestA !== -1) {
            reAnchored.push({
              sIdx: s,
              aIdx: bestA,
              clipIdx: asrWords[bestA].clipIdx,
              sim: bestSim
            });
            curA = bestA;
            misses = 0;
          } else {
            misses++;
            if (misses >= 2) break;
          }
        }
        reAnchored.reverse();
        result.splice(k1 + 1, k2 - k1 - 1, ...reAnchored);
      }
    }
  }
  return result;
}

/**
 * Core word-to-clip alignment algorithm using Banded Global Dynamic Programming (Needleman-Wunsch).
 * Prevents greedy forward lookahead drift and preserves exact clip timestamps.
 */
function alignWordsToTargetClips<T extends { id: string; start?: number; inPoint?: number; outPoint?: number; style?: { text?: string }; text?: string }>(
  scriptWords: string[],
  targetClips: T[]
): T[] {
  if (!scriptWords.length || !targetClips.length) return targetClips;

  const asrWords: AsrWord[] = [];
  targetClips.forEach((clip, clipIdx) => {
    const text = (clip as any).asrText || clip.style?.text || clip.text || '';
    const words = text.match(/\S+/gu) || [];
    const clipStart = typeof clip.start === 'number' ? clip.start : clipIdx * 2.0;
    words.forEach((w, wordIdx) => {
      asrWords.push({
        clipIdx,
        wordIdx,
        orig: w,
        norm: normalizeWord(w),
        phon: phoneticNormalize(w),
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

  const scriptTokens: TokenInfo[] = scriptWords.map(w => ({
    orig: w,
    norm: normalizeWord(w),
    phon: phoneticNormalize(w)
  }));

  const S = scriptTokens.length;
  const A = asrWords.length;
  const BAND = Math.max(45, Math.min(240, Math.round(Math.max(S, A) * 0.065)));

  const rowOffset = new Int32Array(S + 1);
  const rowLen = new Int32Array(S + 1);
  const rowStartIdx = new Int32Array(S + 1);
  let totalCells = 0;

  for (let i = 0; i <= S; i++) {
    const centerJ = Math.round((i / Math.max(1, S)) * A);
    const minJ = Math.max(0, centerJ - BAND);
    const maxJ = Math.min(A, centerJ + BAND);
    rowOffset[i] = minJ;
    rowLen[i] = maxJ - minJ + 1;
    rowStartIdx[i] = totalCells;
    totalCells += rowLen[i];
  }

  const NEG_INF = -1e9;
  const dp = new Float32Array(totalCells).fill(NEG_INF);
  // move: 1 = diag match, 2 = up (skip script word), 3 = left (skip ASR word), 4 = diag mismatch
  const move = new Uint8Array(totalCells);

  const cellIdx = (i: number, j: number): number => {
    const minJ = rowOffset[i];
    const len = rowLen[i];
    if (j < minJ || j >= minJ + len) return -1;
    return rowStartIdx[i] + (j - minJ);
  };

  const SKIP_PENALTY = 0.05;
  dp[cellIdx(0, 0)] = 0;
  for (let j = 1; j < rowOffset[0] + rowLen[0]; j++) {
    const c = cellIdx(0, j);
    dp[c] = -j * SKIP_PENALTY;
    move[c] = 3;
  }

  for (let i = 1; i <= S; i++) {
    const st = scriptTokens[i - 1];
    const minSim = st.norm.length <= 2 ? 0.75 : 0.55;
    const expectedJ = (i / Math.max(1, S)) * A;
    const minJ = rowOffset[i];
    const maxJ = minJ + rowLen[i] - 1;

    for (let j = minJ; j <= maxJ; j++) {
      const c = rowStartIdx[i] + (j - minJ);
      let bestScore = NEG_INF;
      let bestMove = 0;

      // 1. Up: skip script word i - 1
      const cUp = cellIdx(i - 1, j);
      if (cUp !== -1 && dp[cUp] > NEG_INF / 2) {
        const sc = dp[cUp] - SKIP_PENALTY;
        if (sc > bestScore) {
          bestScore = sc;
          bestMove = 2;
        }
      }

      // 2. Left: skip ASR word j - 1
      if (j > minJ) {
        const cLeft = c - 1;
        if (dp[cLeft] > NEG_INF / 2) {
          const sc = dp[cLeft] - SKIP_PENALTY;
          if (sc > bestScore) {
            bestScore = sc;
            bestMove = 3;
          }
        }
      }

      // 3. Diagonal: pair scriptTokens[i - 1] with asrWords[j - 1]
      if (j >= 1) {
        const cDiag = cellIdx(i - 1, j - 1);
        if (cDiag !== -1 && dp[cDiag] > NEG_INF / 2) {
          const aw = asrWords[j - 1];
          const sim = fastTokenSimilarity(st.norm, st.phon, aw.norm, aw.phon);
          if (sim >= minSim) {
            const driftPenalty = (Math.abs(j - expectedJ) / BAND) * 0.12;
            const gain = sim * sim * 2.2 - driftPenalty;
            const sc = dp[cDiag] + gain;
            if (sc > bestScore) {
              bestScore = sc;
              bestMove = 1;
            }
          } else {
            const sc = dp[cDiag] - SKIP_PENALTY * 1.6;
            if (sc > bestScore) {
              bestScore = sc;
              bestMove = 4;
            }
          }
        }
      }

      dp[c] = bestScore;
      move[c] = bestMove;
    }
  }

  let rawAnchors: Anchor[] = [];
  let curI = S;
  let curJ = A;
  const endC = cellIdx(curI, curJ);
  if (endC === -1 || dp[endC] <= NEG_INF / 2) {
    let bestEndScore = NEG_INF;
    for (let j = rowOffset[S]; j < rowOffset[S] + rowLen[S]; j++) {
      const c = cellIdx(S, j);
      if (dp[c] > bestEndScore) {
        bestEndScore = dp[c];
        curI = S;
        curJ = j;
      }
    }
  }

  while (curI > 0 && curJ > 0) {
    const c = cellIdx(curI, curJ);
    if (c === -1) break;
    const m = move[c];
    if (m === 1) {
      const sIdx = curI - 1;
      const aIdx = curJ - 1;
      const st = scriptTokens[sIdx];
      const aw = asrWords[aIdx];
      rawAnchors.push({
        sIdx,
        aIdx,
        clipIdx: aw.clipIdx,
        sim: fastTokenSimilarity(st.norm, st.phon, aw.norm, aw.phon)
      });
      curI--;
      curJ--;
    } else if (m === 2) {
      curI--;
    } else if (m === 3) {
      curJ--;
    } else if (m === 4) {
      curI--;
      curJ--;
    } else {
      break;
    }
  }
  rawAnchors.reverse();

  const minRequiredAnchors = S >= 3 ? Math.max(1, Math.min(2, Math.floor(S * 0.15))) : 1;
  if (rawAnchors.length < minRequiredAnchors) {
    throw new Error('Оруулсан скрипт хадмалын үгстэй таарахгүй байна.');
  }

  const anchors = healShiftedDuplicateRegions(rawAnchors, scriptTokens, asrWords);

  // Map every script word to its target clip index using anchored ASR positions
  const wordClipIdx = new Int32Array(S);
  const firstA = anchors[0];
  for (let s = 0; s < firstA.sIdx; s++) {
    if (firstA.aIdx > 0) {
      const mappedA = Math.min(firstA.aIdx - 1, Math.floor((s / Math.max(1, firstA.sIdx)) * firstA.aIdx));
      wordClipIdx[s] = asrWords[mappedA].clipIdx;
    } else {
      wordClipIdx[s] = firstA.clipIdx;
    }
  }

  for (let k = 0; k < anchors.length; k++) {
    const a1 = anchors[k];
    wordClipIdx[a1.sIdx] = a1.clipIdx;
    if (k < anchors.length - 1) {
      const a2 = anchors[k + 1];
      const sCount = a2.sIdx - a1.sIdx - 1;
      if (sCount > 0) {
        const aCount = a2.aIdx - a1.aIdx - 1;
        let switchedToNext = false;
        for (let offset = 1; offset <= sCount; offset++) {
          const s = a1.sIdx + offset;
          if (a1.clipIdx === a2.clipIdx) {
            wordClipIdx[s] = a1.clipIdx;
          } else if (aCount > 0) {
            const rel = (offset - 0.5) / sCount;
            const mappedA = a1.aIdx + 1 + Math.min(aCount - 1, Math.floor(rel * aCount));
            wordClipIdx[s] = asrWords[mappedA].clipIdx;
          } else {
            const prevWord = scriptWords[s - 1] || '';
            if (/[.!?…]["'»”’)]?$/.test(prevWord)) {
              switchedToNext = true;
            }
            wordClipIdx[s] = switchedToNext ? a2.clipIdx : a1.clipIdx;
          }
        }
      }
    }
  }

  const lastA = anchors[anchors.length - 1];
  const remS = S - 1 - lastA.sIdx;
  const remA = A - 1 - lastA.aIdx;
  for (let offset = 1; offset <= remS; offset++) {
    const s = lastA.sIdx + offset;
    if (remA > 0) {
      const rel = (offset - 0.5) / remS;
      const mappedA = lastA.aIdx + 1 + Math.min(remA - 1, Math.floor(rel * remA));
      wordClipIdx[s] = asrWords[mappedA].clipIdx;
    } else {
      wordClipIdx[s] = lastA.clipIdx;
    }
  }

  for (let s = 1; s < S; s++) {
    if (wordClipIdx[s] < wordClipIdx[s - 1]) {
      wordClipIdx[s] = wordClipIdx[s - 1];
    }
  }

  const clipAlloc: string[][] = Array.from({ length: targetClips.length }, () => []);
  for (let s = 0; s < S; s++) {
    clipAlloc[wordClipIdx[s]].push(scriptWords[s]);
  }

  // Ensure no clip is left empty when there are enough script words to cover every clip
  if (S >= targetClips.length) {
    for (let c = 0; c < targetClips.length; c++) {
      if (clipAlloc[c].length === 0) {
        let donor = -1;
        for (let dist = 1; dist < targetClips.length; dist++) {
          if (c - dist >= 0 && clipAlloc[c - dist].length >= 2) {
            donor = c - dist;
            break;
          }
          if (c + dist < targetClips.length && clipAlloc[c + dist].length >= 2) {
            donor = c + dist;
            break;
          }
        }
        if (donor !== -1) {
          if (donor < c) {
            for (let k = donor; k < c; k++) {
              const moved = clipAlloc[k].pop()!;
              clipAlloc[k + 1].unshift(moved);
            }
          } else {
            for (let k = donor; k > c; k--) {
              const moved = clipAlloc[k].shift()!;
              clipAlloc[k - 1].push(moved);
            }
          }
        }
      }
    }
  }

  return targetClips.map((clip, idx) => {
    const newText = clipAlloc[idx].join(' ');
    return {
      ...clip,
      text: newText,
      style: clip.style ? { ...clip.style, text: newText } : ({ text: newText } as any)
    };
  });
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
  if (requestedMode === 'selected') {
    const selId = options.selectedClipId;
    const selIdx = clips.findIndex(c => c.id === selId);

    if (selIdx !== -1) {
      let endIdx = selIdx;
      let accWords = 0;
      for (let i = selIdx; i < clips.length; i++) {
        const wLen = ((clips[i].style?.text || clips[i].text || '').match(/\S+/gu) || []).length;
        accWords += Math.max(1, wLen);
        endIdx = i;
        if (accWords >= rawWords.length * 0.8) break;
      }
      const targetSlice = clips.slice(selIdx, endIdx + 1);

      const alignedSlice = alignWordsToTargetClips(rawWords, targetSlice);
      const sliceMap = new Map(alignedSlice.map(c => [c.id, c]));

      const updatedClips = clips.map(c => sliceMap.get(c.id) || c);

      return {
        updatedClips,
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

  // 2. Auto Mode: Check if this is a partial snippet (< 45% of total words and >= 6 clips)
  const isPartial = requestedMode === 'auto' && rawWords.length < Math.max(15, totalTimelineWords * 0.45) && clips.length >= 6;

  if (isPartial) {
    const windowFound = findBestClipWindow(rawWords, clips);
    if (windowFound && (windowFound.score > 5 || windowFound.end - windowFound.start >= 1)) {
      const targetSlice = clips.slice(windowFound.start, windowFound.end + 1);
      const alignedSlice = alignWordsToTargetClips(rawWords, targetSlice);
      const sliceMap = new Map(alignedSlice.map(c => [c.id, c]));

      const updatedClips = clips.map(c => sliceMap.get(c.id) || c);

      return {
        updatedClips,
        updatedCount: targetSlice.length,
        matchedRange: { start: windowFound.start, end: windowFound.end },
        modeUsed: 'auto',
        message: `Таарсан #${windowFound.start + 1}-ээс #${windowFound.end + 1} хүртэлх ${targetSlice.length} хадмалыг скриптээр заслаа.`
      };
    }
  }

  // 3. Full Script Mode: Align across all clips
  const updatedClips = alignWordsToTargetClips(rawWords, clips);

  return {
    updatedClips,
    updatedCount: clips.length,
    matchedRange: { start: 0, end: clips.length - 1 },
    modeUsed: 'full',
    message: `Нийт ${clips.length} хадмалыг бүрэн зохиолоор амжилттай заслаа.`
  };
}
