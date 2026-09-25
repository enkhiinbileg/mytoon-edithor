'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function check(signal) { if (signal?.aborted) throw new Error('Stopped. Completed work is saved; run again to resume.'); }
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function write(file, data) {
  const tmp = file + '.part';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
// One limiter shared by every pipeline chunk. Never multiply provider concurrency.
function limiter(size, signal) {
  size = Math.max(1, Math.min(20, Math.floor(Number(size) || 1)));
  let active = 0;
  const queue = [];
  function drain() {
    while (active < size && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(() => { check(signal); return fn(); }).then(resolve, reject)
        .finally(() => { active--; drain(); });
    }
  }
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); drain(); });
}
async function map(items, size, fn, signal) {
  let cursor = 0, failure;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (!failure && cursor < items.length) {
      const i = cursor++;
      try { check(signal); results[i] = await fn(items[i], i); }
      catch (err) { failure ||= err; }
    }
  }));
  if (failure) throw failure;
  return results;
}
module.exports = { hash, check, read, write, limiter, map };
