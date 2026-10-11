'use strict';

// Keep each decoding window below Whisper's 30-second context. The extra
// audio on both sides lets it hear words cut by a timeline boundary.
function planRecognitionChunks(start, duration, chunkSeconds = 25, contextSeconds = 1) {
  if (!(duration > 0)) return [{ start, duration: undefined, coreStart: start, coreEnd: Infinity }];
  const end = start + duration;
  const chunks = [];
  for (let coreStart = start; coreStart < end; coreStart += chunkSeconds) {
    const coreEnd = Math.min(end, coreStart + chunkSeconds);
    const requestStart = Math.max(start, coreStart - contextSeconds);
    const requestEnd = Math.min(end, coreEnd + contextSeconds);
    chunks.push({ start: requestStart, duration: requestEnd - requestStart, coreStart, coreEnd });
  }
  return chunks;
}

function ownChunkWords(words, chunk) {
  return words.flatMap(word => {
    const start = chunk.start + word.start;
    const end = chunk.start + word.end;
    const midpoint = (start + end) / 2;
    if (midpoint < chunk.coreStart || midpoint >= chunk.coreEnd) return [];
    return [{ ...word, start, end }];
  });
}

// Jointly resolve observations from neighboring decoding windows. Independent
// midpoint filters can both reject (or both retain) a word when its estimated
// timestamp moves across the boundary between requests.
function stitchRecognitionChunks(items) {
  if (!items.length) return [];
  const sourceStart = items[0].chunk.coreStart;
  const sourceEnd = items[items.length - 1].chunk.coreEnd;
  const lexicalKey = text => String(text || '').toLocaleLowerCase('mn').replace(/[^\p{L}\p{N}]/gu, '');
  let observationId = 0;
  const observations = items.map(({ chunk, words }, chunkIndex) => words.flatMap(word => {
    const start = Math.max(sourceStart, chunk.start + word.start);
    const end = Math.min(sourceEnd, chunk.start + word.end);
    if (!String(word.word || '').trim() || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const midpoint = (start + end) / 2;
    return [{ ...word, start, end, chunkIndex, observationId: observationId++,
      owned: midpoint >= chunk.coreStart && midpoint < chunk.coreEnd,
      contextQuality: Math.min(midpoint - chunk.start, chunk.start + (chunk.duration ?? Infinity) - midpoint)
    }];
  }));
  const retained = new Set(observations.flat().filter(word => word.owned).map(word => word.observationId));

  for (let i = 1; i < items.length; i++) {
    const overlapStart = items[i].chunk.start;
    const previousChunk = items[i - 1].chunk;
    const overlapEnd = previousChunk.start + (previousChunk.duration ?? Infinity);
    const left = observations[i - 1].filter(word => word.end > overlapStart && word.start < overlapEnd);
    const right = observations[i].filter(word => word.end > overlapStart && word.start < overlapEnd);
    const pairs = [];
    left.forEach(a => right.forEach(b => {
      const key = lexicalKey(a.word);
      if (!key || key !== lexicalKey(b.word)) return;
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      const shorterDuration = Math.min(a.end - a.start, b.end - b.start);
      const midpointDistance = Math.abs((a.start + a.end - b.start - b.end) / 2);
      // Require matching acoustic time, not just nearby equal text. Separate
      // spoken repetitions with nonoverlapping spans must remain separate.
      if (overlap < shorterDuration * 0.25 || midpointDistance > 1) return;
      pairs.push({ a, b, distance: midpointDistance });
    }));
    pairs.sort((a, b) => a.distance - b.distance);
    const matchedLeft = new Set();
    const matchedRight = new Set();
    for (const { a, b } of pairs) {
      if (matchedLeft.has(a.observationId) || matchedRight.has(b.observationId)) continue;
      matchedLeft.add(a.observationId);
      matchedRight.add(b.observationId);
      const representative = b.contextQuality > a.contextQuality ? b : a;
      retained.delete(a.observationId);
      retained.delete(b.observationId);
      retained.add(representative.observationId);
    }
    // If only the context request heard a boundary word, keep it when the
    // owning request has no observation at that acoustic time. Do not add
    // alternative spellings over an already represented spoken word.
    for (const word of [...left, ...right]) {
      if (word.owned || retained.has(word.observationId) || matchedLeft.has(word.observationId) || matchedRight.has(word.observationId)) continue;
      const represented = [...left, ...right].some(other => {
        if (!retained.has(other.observationId)) return false;
        const overlap = Math.min(word.end, other.end) - Math.max(word.start, other.start);
        return overlap > Math.min(word.end - word.start, other.end - other.start) * 0.25;
      });
      if (!represented) retained.add(word.observationId);
    }
  }

  return observations.flat().filter(word => retained.has(word.observationId))
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map(({ observationId: _id, owned: _owned, contextQuality: _quality, ...word }) => word);
}

module.exports = { planRecognitionChunks, ownChunkWords, stitchRecognitionChunks };
