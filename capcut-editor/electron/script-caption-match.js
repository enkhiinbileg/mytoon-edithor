'use strict';

function normalizeWord(w) {
  return String(w || '').toLowerCase().replace(/[^a-zа-яёөү\d]/gi, '');
}

function wordSimilarity(w1, w2) {
  const s1 = normalizeWord(w1);
  const s2 = normalizeWord(w2);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;
  if (s1.includes(s2) || s2.includes(s1)) return 0.85;

  const m = s1.length;
  const n = s2.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
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

const words = text => String(text).toLocaleLowerCase('mn').match(/[\p{L}\p{N}]+/gu) || [];

/**
 * Robust fuzzy alignment between clean script sentences and Whisper recognized segments.
 * Replaces Whisper's noisy spelling with clean script text, keeping millisecond-accurate timestamps.
 */
function matchScript(sentences, recognized, duration, actualWords = []) {
  if ((!recognized || !recognized.length) && (!actualWords || !actualWords.length)) {
    throw new Error('Аудионоос яриа танигдсангүй.');
  }
  if (!sentences || !sentences.length) {
    return (recognized || []).map((seg, i) => ({
      id: i + 1,
      index: i,
      text: seg.text,
      start: seg.start,
      end: seg.end,
      duration: Math.max(0.2, seg.end - seg.start),
      method: 'whisper_direct'
    }));
  }

  // Use precise word-level timestamps if available, or flatten recognized segments
  const tokens = [];
  if (Array.isArray(actualWords) && actualWords.length > 0) {
    for (const w of actualWords) {
      if (w.word && Number.isFinite(w.start) && Number.isFinite(w.end)) {
        tokens.push({
          word: w.word,
          start: w.start,
          end: w.end
        });
      }
    }
  }

  if (tokens.length === 0) {
    for (const segment of recognized) {
      if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) continue;
      const list = words(segment.text);
      if (!list.length) continue;
      const segDur = segment.end - segment.start;
      list.forEach((word, i) => {
        tokens.push({
          word,
          start: Math.max(0, segment.start + (i / list.length) * segDur),
          end: Math.min(duration, segment.start + ((i + 1) / list.length) * segDur)
        });
      });
    }
  }

  if (!tokens.length) {
    throw new Error('Танигдсан үгсийн сан хоосон байна.');
  }

  let cursor = 0;
  const result = [];
  const totalTokens = tokens.length;

  for (let index = 0; index < sentences.length; index++) {
    const text = sentences[index];
    const expected = words(text);
    const expectedLen = Math.max(1, expected.length);

    let bestStart = cursor;
    let bestEnd = Math.min(totalTokens - 1, cursor + expectedLen);
    let bestScore = -1;

    const searchWindow = Math.min(totalTokens, cursor + expectedLen * 3 + 15);

    // Find best anchor for first expected word
    for (let s = cursor; s < searchWindow; s++) {
      const simFirst = wordSimilarity(tokens[s].word, expected[0]);
      if (simFirst < 0.5) continue;

      let at = s;
      let hits = simFirst;
      let lastMatch = s;

      for (let w = 1; w < expected.length; w++) {
        const lookAheadLimit = Math.min(totalTokens, at + 6);
        let bestSubSim = 0;
        let bestSubIdx = -1;

        for (let j = at + 1; j < lookAheadLimit; j++) {
          const sim = wordSimilarity(tokens[j].word, expected[w]);
          if (sim > bestSubSim) {
            bestSubSim = sim;
            bestSubIdx = j;
          }
        }

        if (bestSubIdx >= 0 && bestSubSim >= 0.55) {
          hits += bestSubSim;
          at = bestSubIdx;
          lastMatch = bestSubIdx;
        }
      }

      const score = hits / expectedLen - (s - cursor) * 0.02;
      if (score > bestScore) {
        bestScore = score;
        bestStart = s;
        bestEnd = lastMatch;
      }
    }

    let start = tokens[bestStart].start;
    let end = tokens[bestEnd].end;

    // Safety fallback: anchor to actual spoken audio tokens at cursor rather than guessing artificial durations
    if (bestScore < 0.35) {
      const fallbackEndIdx = Math.min(totalTokens - 1, cursor + expectedLen - 1);
      start = tokens[cursor]?.start ?? (result.length > 0 ? result[result.length - 1].end : 0);
      end = tokens[fallbackEndIdx]?.end ?? (start + Math.max(0.4, expectedLen * 0.3));
      cursor = Math.min(totalTokens - 1, fallbackEndIdx + 1);
    } else {
      cursor = Math.min(totalTokens - 1, bestEnd + 1);
    }

    if (result.length > 0) {
      const prev = result[result.length - 1];
      if (start < prev.end + 0.02) {
        start = Math.round((prev.end + 0.03) * 1000) / 1000;
      }
    }
    if (end <= start) {
      end = Math.round((start + Math.max(0.3, expectedLen * 0.28)) * 1000) / 1000;
    }

    result.push({
      id: index + 1,
      index,
      text,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      duration: Math.round((end - start) * 1000) / 1000,
      method: 'script_word_anchors',
      confidence: Math.max(0.5, bestScore)
    });
  }

  return result;
}

module.exports = { matchScript, wordSimilarity };
