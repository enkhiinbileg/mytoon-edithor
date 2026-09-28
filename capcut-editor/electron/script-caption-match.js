'use strict';
const words = text => String(text).toLocaleLowerCase('mn').match(/[\p{L}\p{N}]+/gu) || [];
// Use recognized words as ordered anchors. Times inside a Whisper segment are
// interpolated, so these are estimated caption boundaries, not forced alignment.
function matchScript(sentences, recognized, duration) {
  const tokens = [];
  for (const segment of recognized) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) continue;
    const list = words(segment.text);
    list.forEach((word, i) => tokens.push({ word,
      start: Math.max(0, segment.start + i / list.length * (segment.end - segment.start)),
      end: Math.min(duration, segment.start + (i + 1) / list.length * (segment.end - segment.start)) }));
  }
  let cursor = 0;
  const result = [];
  for (const [index, text] of sentences.entries()) {
    const expected = words(text);
    if (!expected.length) throw new Error(`Өгүүлбэр ${index + 1}: таних үг олдсонгүй.`);
    let best = null;
    for (let start = cursor; start < Math.min(tokens.length, cursor + 80); start++) {
      if (tokens[start].word !== expected[0]) continue;
      let at = start, hits = 0, last = start;
      for (const word of expected) {
        const limit = Math.min(tokens.length, start + expected.length * 2 + 4, at + 5);
        let found = -1;
        for (let j = at; j < limit; j++) if (tokens[j].word === word) { found = j; break; }
        if (found >= 0) { hits++; last = found; at = found + 1; }
      }
      const score = hits / Math.max(expected.length, last - start + 1);
      if (!best || score > best.score) best = { start, last, score, hits };
    }
    if (!best || best.score < .75 || best.hits < Math.ceil(expected.length * .8)) {
      throw new Error(`Өгүүлбэр ${index + 1}-ийг аудиотой найдвартай тулгаж чадсангүй: «${text.slice(0, 100)}». Скрипт аудионд уншсан тексттэй ижил эсэхийг шалгана уу. Хадмалыг өөрчлөөгүй.`);
    }
    const start = tokens[best.start].start, end = tokens[best.last].end;
    if (!(end > start) || (result.length && start < result[result.length - 1].end)) throw new Error('Ярианы цаг давхцаж байна. Хадмалыг өөрчлөөгүй.');
    result.push({ id: index + 1, index, text, start, end, duration: end - start, method: 'script_word_anchors', confidence: best.score });
    cursor = best.last + 1;
  }
  return result;
}
module.exports = { matchScript };
