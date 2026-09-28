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
function matchScript(sentences, recognized, duration) {
  if (!recognized || !recognized.length) {
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

  // Flatten recognized segments into timestamped tokens
  const tokens = [];
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

    // Safety fallback: if no confident anchor, linearly advance based on word count
    if (bestScore < 0.35) {
      const prevEnd = result.length > 0 ? result[result.length - 1].end : tokens[cursor]?.start || 0;
      start = prevEnd;
      const avgWordDur = (duration || 60) / Math.max(tokens.length, sentences.reduce((acc, s) => acc + words(s).length, 0));
      end = Math.min(duration, start + expectedLen * Math.max(0.3, Math.min(1.2, avgWordDur)));
      cursor = Math.min(totalTokens - 1, cursor + expectedLen);
    } else {
      cursor = Math.min(totalTokens - 1, bestEnd + 1);
    }

    if (result.length > 0 && start < result[result.length - 1].end) {
      start = result[result.length - 1].end;
    }
    if (end <= start) {
      end = start + Math.max(0.5, expectedLen * 0.35);
    }

    result.push({
      id: index + 1,
      index,
      text,
      start,
      end,
      duration: end - start,
      method: 'script_word_anchors',
      confidence: Math.max(0.5, bestScore)
    });
  }

  return result;
}

module.exports = { matchScript, wordSimilarity };
