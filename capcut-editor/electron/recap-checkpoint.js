'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

// Save validated batch replies, never credentials. Input and prompt fingerprints
// prevent reuse after changes to source, captions, model choice or instructions.
function createCheckpoint(directory, input, progress) {
  const job = hash(JSON.stringify(input));
  const root = directory ? path.join(directory, job) : null;
  let warned = false;
  return {
    read(prompt) {
      if (!root) return null;
      try {
        const item = JSON.parse(fs.readFileSync(path.join(root, `${hash(prompt)}.json`), 'utf8'));
        return typeof item.text === 'string' && item.checksum === hash(item.text) ? item.text : null;
      } catch { return null; }
    },
    write(prompt, text) {
      if (!root) return;
      const target = path.join(root, `${hash(prompt)}.json`);
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify({ text, checksum: hash(text) }), { mode: 0o600 });
        fs.renameSync(temporary, target);
      } catch {
        if (!warned) progress?.({ stage: 'mapping', message: 'Багцын үр дүнг түр хадгалж чадсангүй. Тасарвал энэ багцыг дахин тооцно.' });
        warned = true;
      } finally { try { fs.unlinkSync(temporary); } catch { /* Renamed or not created. */ } }
    }
  };
}
module.exports = { createCheckpoint };
