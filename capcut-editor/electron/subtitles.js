'use strict';
const fs = require('node:fs');

/** "00:01:02,500" or "00:01:02.500" (and the 2-field "01:02.500" form) -> seconds */
function toSeconds(stamp) {
  const parts = stamp.trim().replace(',', '.').split(':').map(Number);
  if (parts.some(Number.isNaN)) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return NaN;
}

const CUE = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/;

/**
 * Parse SRT or WebVTT into { id, start, end, text } segments.
 * Both formats share the "start --> end" cue line, so one parser covers them:
 * everything before the first cue (index numbers, WEBVTT header, NOTE blocks,
 * cue settings after the timestamps) is ignored.
 */
function parseSubtitles(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const segments = [];
  let current = null;
  let id = 0;

  for (const line of lines) {
    const m = CUE.exec(line);
    if (m) {
      if (current) segments.push(current);
      const start = toSeconds(m[1]);
      const end = toSeconds(m[2]);
      current = Number.isNaN(start) || Number.isNaN(end)
        ? null
        : { id: id++, start, end, text: '' };
      continue;
    }
    if (!current) continue;
    if (!line.trim()) {
      segments.push(current);
      current = null;
      continue;
    }
    // Strip inline tags (<i>, <c.colour>, {\an8}) that carry no spoken content.
    const clean = line.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').trim();
    if (clean) current.text = current.text ? `${current.text} ${clean}` : clean;
  }
  if (current) segments.push(current);

  return segments.filter((s) => s.text && s.end > s.start);
}

function parseSubtitleFile(filePath) {
  return parseSubtitles(fs.readFileSync(filePath, 'utf8'));
}

module.exports = { parseSubtitles, parseSubtitleFile };
