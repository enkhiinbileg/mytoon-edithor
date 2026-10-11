'use strict';

// Segment text remains usable when the service omits or collapses word timing.
// Recover only recognized text, inside its segment's actual audio boundaries.
function reconcileRecognitionWords(result, totalDuration = Infinity) {
  const transcriptKey = text => String(text || '').toLocaleLowerCase('mn').replace(/[^\p{L}\p{N}]/gu, '');
  const segments = (Array.isArray(result?.segments) ? result.segments : []).map((s, segmentIndex) => ({
    segmentIndex,
    text: String(s.text || '').trim(),
    start: Math.max(0, Math.min(totalDuration, s.start)),
    end: Math.max(0, Math.min(totalDuration, s.end))
  })).filter(s => s.text && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const words = (Array.isArray(result?.words) ? result.words : []).filter(w =>
    String(w.word || '').trim() && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start
  ).map(w => ({ word: String(w.word).trim(),
    ...(w.timingSource ? { timingSource: w.timingSource } : {}),
    start: Math.max(0, Math.min(totalDuration, w.start)),
    end: Math.max(0, Math.min(totalDuration, w.end))
  }));
  if (!segments.length) return words.filter(w => w.end > w.start).sort((a, b) => a.start - b.start);

  function distribute(textWords, start, end, segmentIndex) {
    return textWords.map((word, i) => ({ word,
      start: start + (end - start) * i / textWords.length,
      end: start + (end - start) * (i + 1) / textWords.length,
      timingSource: 'segment',
      segmentIndex
    }));
  }

  const used = new Set();
  const recovered = [];
  for (const segment of segments) {
    const candidates = [];
    words.forEach((word, index) => {
      if (!used.has(index) && word.start < segment.end && word.end >= segment.start) {
        used.add(index);
        candidates.push({ ...word,
          start: Math.max(segment.start, word.start),
          end: Math.min(segment.end, word.end),
          segmentIndex: segment.segmentIndex
        });
      }
    });
    candidates.sort((a, b) => a.start - b.start || a.end - b.end);
    if (!candidates.length || transcriptKey(candidates.map(w => w.word).join(' ')) !== transcriptKey(segment.text)) {
      recovered.push(...distribute(segment.text.match(/\S+/g), segment.start, segment.end, segment.segmentIndex));
      continue;
    }

    let repairWholeSegment = false;
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].end > candidates[i].start) continue;
      const first = i;
      while (i + 1 < candidates.length && candidates[i + 1].end <= candidates[i + 1].start) i++;
      const left = first > 0 ? candidates[first - 1].end : segment.start;
      const right = i + 1 < candidates.length ? candidates[i + 1].start : segment.end;
      if (right - left < (i - first + 1) * 0.001) {
        repairWholeSegment = true;
        break;
      }
      const repaired = distribute(candidates.slice(first, i + 1).map(w => w.word), left, right, segment.segmentIndex);
      candidates.splice(first, repaired.length, ...repaired);
    }
    recovered.push(...(repairWholeSegment
      ? distribute(candidates.map(w => w.word), segment.start, segment.end, segment.segmentIndex)
      : candidates));
  }

  // Retain word-only speech in response regions without any segment transcript.
  words.forEach((word, index) => { if (!used.has(index) && word.end > word.start) recovered.push(word); });
  return recovered.sort((a, b) => a.start - b.start || a.end - b.end);
}

module.exports = { reconcileRecognitionWords };
