'use strict';
const fs = require('node:fs');

/**
 * Parse an SRT timestamp string (e.g. "00:01:23,450" or "00:01:23.450") into seconds (float).
 */
function parseTimestamp(timestampStr) {
  if (!timestampStr) return 0;
  const match = timestampStr.trim().match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!match) return 0;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const ms = parseInt(match[4].padEnd(3, '0').slice(0, 3), 10);
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

/**
 * Format seconds (float) into standard SRT timestamp format ("00:01:23,450").
 */
function formatTimestamp(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.round((s % 1) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

/**
 * Parse raw SRT string content into a structured array of subtitle entries:
 * Array of { id: number, start: number, end: number, duration: number, text: string }
 */
function parseSrt(content) {
  if (!content || typeof content !== 'string') return [];

  // Strip Byte Order Mark (BOM) if present
  let clean = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split into subtitle blocks by two or more newlines
  const blocks = clean.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const entries = [];

  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    // Line 0 is often index number, but some SRTs omit it and start directly with timestamp
    let timeLineIdx = 0;
    if (/-->/.test(lines[1])) {
      timeLineIdx = 1;
    } else if (!/-->/.test(lines[0])) {
      continue;
    }

    const timeMatch = lines[timeLineIdx].match(/([0-9:,\.]+)\s*-->\s*([0-9:,\.]+)/);
    if (!timeMatch) continue;

    const start = parseTimestamp(timeMatch[1]);
    const end = parseTimestamp(timeMatch[2]);
    if (end <= start) continue;

    // Text lines are everything after timeLineIdx
    const textLines = lines.slice(timeLineIdx + 1);
    const rawText = textLines.join(' ');

    // Clean up HTML/formatting tags (e.g. <i>...</i>, <font>...</font>)
    const text = rawText
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]+\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) continue;

    entries.push({
      id: entries.length + 1,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      duration: Math.round((end - start) * 1000) / 1000,
      text
    });
  }

  return entries;
}

/**
 * Parse an SRT file from a filesystem path.
 */
function parseSrtFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`SRT файл олдсонгүй: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return parseSrt(content);
}

/**
 * Intelligently reconstruct complete sentences from fragmented/auto-generated SRT subtitles.
 * Merges short continuous subtitle lines (like YouTube auto-subs) into coherent, complete sentence blocks.
 */
function reconstructSentences(entries, options = {}) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const maxSentenceDuration = options.maxDuration || 8.5;
  const maxPauseGap = options.maxGap || 1.1;

  const reconstructed = [];
  let currentGroup = [];

  const flushGroup = () => {
    if (!currentGroup.length) return;
    const first = currentGroup[0];
    const last = currentGroup[currentGroup.length - 1];
    const combinedText = currentGroup
      .map((e) => e.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    reconstructed.push({
      id: reconstructed.length + 1,
      start: first.start,
      end: last.end,
      duration: Math.round((last.end - first.start) * 1000) / 1000,
      text: combinedText,
      rawIds: currentGroup.map((e) => e.id)
    });
    currentGroup = [];
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    currentGroup.push(entry);

    const first = currentGroup[0];
    const groupDur = entry.end - first.start;
    const isTerminal = /[.!?]["']?$/.test(entry.text.trim());

    const nextEntry = entries[i + 1];
    const hasLongPause = nextEntry ? (nextEntry.start - entry.end > maxPauseGap) : true;
    const exceedsDuration = groupDur >= maxSentenceDuration;

    if (isTerminal || hasLongPause || exceedsDuration || !nextEntry) {
      flushGroup();
    }
  }

  // De-overlap consecutive blocks (e.g. YouTube 2-line rollup captions where cue[k].end > cue[k+1].start)
  const byRawId = new Map(entries.map((e) => [e.id, e]));
  for (let i = 0; i < reconstructed.length; i++) {
    const cur = reconstructed[i];
    Object.defineProperty(cur, 'rawStart', { value: cur.start, enumerable: false, configurable: true });
    Object.defineProperty(cur, 'rawEnd', { value: cur.end, enumerable: false, configurable: true });
    Object.defineProperty(cur, 'rawDuration', { value: cur.duration, enumerable: false, configurable: true });
  }
  for (let i = 0; i < reconstructed.length - 1; i++) {
    const cur = reconstructed[i];
    const next = reconstructed[i + 1];
    if (cur.rawEnd > next.rawStart && next.rawStart > cur.start) {
      const lastCue = byRawId.get(cur.rawIds?.at(-1));
      const nextCue = byRawId.get(next.rawIds?.[0]);
      const secondNextCue = next.rawIds?.[0] !== undefined ? byRawId.get(next.rawIds[0] + 1) : null;
      const lastSpokenStart = lastCue ? lastCue.start : cur.start;
      const lastSpokenEnd = lastCue ? Math.min(lastCue.end, next.rawStart) : next.rawStart;
      let boundary = lastSpokenEnd;
      if (lastCue && nextCue) {
        const trimmedLast = lastCue.text.trim();
        if (!/[.!?…]["'”»)\]]*$/.test(trimmedLast)) {
          const mLast = trimmedLast.match(/^(.*[.!?…]["'”»)\]]*)\s+\S+.*$/);
          if (mLast) {
            const r = mLast[1].length / trimmedLast.length;
            boundary = lastSpokenStart + r * (lastSpokenEnd - lastSpokenStart);
          } else {
            const trimmedNext = nextCue.text.trim();
            const mNext = trimmedNext.match(/^([^.!?…]+[.!?…]["'”»)\]]*)\s+\S+.*$/);
            if (mNext && mNext[1].length < trimmedNext.length * 0.65) {
              const nextSpokenEnd = (secondNextCue && secondNextCue.start > nextCue.start) ? Math.min(nextCue.end, secondNextCue.start) : nextCue.end;
              const r = mNext[1].length / trimmedNext.length;
              boundary = nextCue.start + r * (nextSpokenEnd - nextCue.start);
            }
          }
        }
      }
      boundary = Math.round(boundary * 1000) / 1000;
      if (boundary <= cur.start + 0.2 || boundary >= next.rawEnd - 0.2) {
        boundary = Math.round(next.rawStart * 1000) / 1000;
      }
      cur.end = boundary;
      cur.duration = Math.round((cur.end - cur.start) * 1000) / 1000;
      next.start = boundary;
      next.duration = Math.round((next.end - next.start) * 1000) / 1000;
    }
  }

  return reconstructed;
}

/**
 * Format subtitle entries back into standard SRT text.
 */
function stringifySrt(entries) {
  if (!Array.isArray(entries) || !entries.length) return '';
  return entries
    .map((e, idx) => {
      const num = idx + 1;
      const s = formatTimestamp(e.start);
      const en = formatTimestamp(e.end);
      return `${num}\n${s} --> ${en}\n${e.text}\n`;
    })
    .join('\n');
}

/**
 * Slice subtitle entries starting from startTime (and optional endTime),
 * and shift all timestamps so that the slice starts at 00:00:00.
 */
function sliceAndShiftSrt(entries, startTime, endTime = null) {
  if (!Array.isArray(entries) || !entries.length) {
    return { startSec: 0, endSec: null, entries: [] };
  }

  let startSec = 0;
  if (typeof startTime === 'number') {
    startSec = Math.max(0, startTime);
  } else if (typeof startTime === 'string' && startTime.trim()) {
    const s = startTime.trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      startSec = parseFloat(s);
    } else {
      startSec = parseTimestamp(s.includes(',') || s.includes('.') ? s : `${s},000`);
    }
  }

  let endSec = null;
  if (typeof endTime === 'number') {
    endSec = endTime > startSec ? endTime : null;
  } else if (typeof endTime === 'string' && endTime.trim()) {
    const s = endTime.trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      endSec = parseFloat(s);
    } else {
      endSec = parseTimestamp(s.includes(',') || s.includes('.') ? s : `${s},000`);
    }
    if (endSec <= startSec) endSec = null;
  }

  const sliced = entries
    .filter((e) => e.end > startSec && (!endSec || e.start < endSec))
    .map((e, idx) => {
      const shiftedStart = Math.max(0, Math.round((e.start - startSec) * 1000) / 1000);
      const shiftedEnd = Math.max(0.1, Math.round((e.end - startSec) * 1000) / 1000);
      return {
        id: idx + 1,
        start: shiftedStart,
        end: shiftedEnd,
        duration: Math.round((shiftedEnd - shiftedStart) * 1000) / 1000,
        text: e.text
      };
    });

  return { startSec, endSec, entries: sliced };
}

module.exports = {
  parseTimestamp,
  formatTimestamp,
  parseSrt,
  parseSrtFile,
  reconstructSentences,
  stringifySrt,
  sliceAndShiftSrt
};
