'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');

// Only exact synthesis requests share audio. Credentials are never persisted here.
function createPartCache(outDir, options) {
  const root = path.resolve(outDir);
  const dir = path.join(root, 'resume-v1');
  const key = text => hash(JSON.stringify({ version: 1, ...options, text }));

  async function validateEntry(entry) {
    try {
      if (typeof entry?.file !== 'string' || path.basename(entry.file) !== entry.file) return null;
      const audio = path.join(root, entry.file);
      if (!Number.isFinite(entry.duration) || entry.duration <= 0 || !Array.isArray(entry.sentences)) return null;
      const bytes = await fs.readFile(audio);
      if (!bytes.length || hash(bytes) !== entry.audioHash) return null;
      return { partAudioFile: audio, partDuration: entry.duration, partSentences: entry.sentences, keyUsed: 'Хадгалсан аудио' };
    } catch {
      return null;
    }
  }

  let indexedEntriesPromise = null;
  function loadValidEntries() {
    if (!indexedEntriesPromise) {
      indexedEntriesPromise = (async () => {
        const list = [];
        let names = [];
        try { names = await fs.readdir(dir); } catch { return list; }
        for (const name of names) {
          if (!name.endsWith('.json') || name.endsWith('.split.json')) continue;
          const entryHash = name.slice(0, -5);
          try {
            const raw = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
            const validated = await validateEntry(raw);
            if (!validated || !validated.partSentences.length) continue;
            list.push({ entryHash, hit: validated });
          } catch {}
        }
        return list;
      })();
    }
    return indexedEntriesPromise;
  }

  async function read(text) {
    try {
      const entry = JSON.parse(await fs.readFile(path.join(dir, key(text) + '.json'), 'utf8'));
      return await validateEntry(entry);
    } catch { return null; }
  }

  async function write(text, result) {
    if (path.dirname(path.resolve(result.partAudioFile)) !== root) throw new Error('Audio cache path mismatch');
    const bytes = await fs.readFile(result.partAudioFile);
    if (!bytes.length) throw new Error('Empty audio cannot be cached');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, key(text) + '.json');
    const tmp = target + '.' + randomUUID() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify({ file: path.basename(result.partAudioFile), audioHash: hash(bytes),
      duration: result.partDuration, sentences: result.partSentences }));
    await fs.rename(tmp, target);
  }

  async function writeSplit(parentText, parts) {
    if (!Array.isArray(parts) || parts.length < 2) return;
    try {
      await fs.mkdir(dir, { recursive: true });
      const target = path.join(dir, key(parentText) + '.split.json');
      const tmp = target + '.' + randomUUID() + '.tmp';
      await fs.writeFile(tmp, JSON.stringify({ split: parts }));
      await fs.rename(tmp, target);
    } catch {}
  }

  async function readSplit(parentText) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, key(parentText) + '.split.json'), 'utf8'));
      return Array.isArray(data?.split) && data.split.length >= 2 ? data.split : null;
    } catch {
      return null;
    }
  }

  /**
   * Recover cached sub-chunks inside `text`, supporting both explicit `.split.json`
   * manifests and SHA-256 verified sentence matching against prior split audio parts.
   */
  async function recoverSegments(text, depth = 0) {
    const clean = String(text || '').trim();
    if (!clean) return [];

    const exact = await read(clean);
    if (exact) return [{ type: 'cached', hit: exact }];

    if (depth < 12) {
      const splitParts = await readSplit(clean);
      if (splitParts) {
        const resolved = [];
        for (const p of splitParts) {
          resolved.push(...await recoverSegments(p, depth + 1));
        }
        return resolved;
      }
    }

    // Backwards recovery: scan prior sub-chunk entries whose sentences match SHA-256 slice of `clean`
    const entries = await loadValidEntries();
    if (!entries.length) return [{ type: 'missing', text: clean }];

    const spans = [];
    for (const item of entries) {
      const sents = item.hit.partSentences;
      const firstText = String(sents[0]?.text || '').trim();
      const lastText = String(sents[sents.length - 1]?.text || '').trim();
      if (!firstText || !lastText) continue;
      const approxLen = sents.reduce((acc, s) => acc + String(s.text || '').length + 1, 0);
      if (approxLen > clean.length + 250) continue;

      let searchFrom = 0;
      let matched = false;
      while (searchFrom < clean.length && !matched) {
        const startIdx = clean.indexOf(firstText, searchFrom);
        if (startIdx < 0) break;

        // Try candidate end positions around expected slice length
        const windowStart = Math.max(startIdx, startIdx + approxLen - lastText.length - 200);
        const windowEnd = Math.min(clean.length, startIdx + approxLen + lastText.length + 250);
        let endSearch = Math.max(startIdx, windowStart);
        while (endSearch <= windowEnd) {
          const lastIdx = clean.indexOf(lastText, endSearch);
          if (lastIdx < 0 || lastIdx > windowEnd) break;
          const endIdx = lastIdx + lastText.length;
          const candidate = clean.slice(startIdx, endIdx).trim();
          if (key(candidate) === item.entryHash) {
            spans.push({ start: startIdx, end: endIdx, hit: item.hit });
            matched = true;
            break;
          }
          endSearch = lastIdx + 1;
        }
        searchFrom = startIdx + 1;
      }
    }

    if (!spans.length) return [{ type: 'missing', text: clean }];

    // Select non-overlapping spans in strict left-to-right order
    spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const segments = [];
    let cursor = 0;
    for (const sp of spans) {
      if (sp.start < cursor) continue;
      const gap = clean.slice(cursor, sp.start).trim();
      if (gap) segments.push({ type: 'missing', text: gap });
      segments.push({ type: 'cached', hit: sp.hit });
      cursor = sp.end;
    }
    const tail = clean.slice(cursor).trim();
    if (tail) segments.push({ type: 'missing', text: tail });
    return segments;
  }

  return {
    read,
    write,
    writeSplit,
    recoverSegments
  };
}
module.exports = { createPartCache };
