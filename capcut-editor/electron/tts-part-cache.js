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
  return {
    async read(text) {
      try {
        const entry = JSON.parse(await fs.readFile(path.join(dir, key(text) + '.json'), 'utf8'));
        if (typeof entry.file !== 'string' || path.basename(entry.file) !== entry.file) return null;
        const audio = path.join(root, entry.file);
        if (!Number.isFinite(entry.duration) || entry.duration <= 0 || !Array.isArray(entry.sentences)) return null;
        const bytes = await fs.readFile(audio);
        if (!bytes.length || hash(bytes) !== entry.audioHash) return null;
        return { partAudioFile: audio, partDuration: entry.duration, partSentences: entry.sentences, keyUsed: 'Хадгалсан аудио' };
      } catch { return null; }
    },
    async write(text, result) {
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
  };
}
module.exports = { createPartCache };
