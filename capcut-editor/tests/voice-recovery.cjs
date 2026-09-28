const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { scanLatestParts, mergeLatestParts } = require('../electron/voice-recovery');
test('legacy recovery sorts numerically, excludes older runs and requires gap acknowledgment', async () => {
 const root = path.resolve('.test-output'); await fs.mkdir(root, { recursive: true });
 const dir = await fs.mkdtemp(path.join(root, 'recovery-'));
 const now = Date.now() - 60000;
 async function add(index, stamp) {
  const file = path.join(dir, `pool_part_${index}_${stamp}_test.mp3`);
  await fs.writeFile(file, 'test'); await fs.utimes(file, now / 1000, now / 1000);
 }
 await add(0, now - 3600000); await add(1, now - 3600000);
 await add(10, now + 10); await add(0, now); await add(2, now + 2);
 let scan = await scanLatestParts(dir);
 assert.deepEqual(scan.parts.map(p => p.index), [0, 2, 10]);
 assert.deepEqual(scan.missing, [2, 4, 5, 6, 7, 8, 9, 10]);
 let merged;
 const ff = { probe: async file => ({ hasAudio: true, duration: path.basename(file).startsWith('recovered_') ? 3 : 1 }),
  concatAudioFiles: async (files, output) => { merged = files; await fs.writeFile(output, 'merged'); } };
 await assert.rejects(mergeLatestParts({ dir, token: scan.token }, ff), /Дутуу/);
 const result = await mergeLatestParts({ dir, token: scan.token, allowGaps: true }, ff);
 assert.deepEqual(merged.map(f => Number(path.basename(f).split('_')[2])), [0, 2, 10]);
 const report = JSON.parse(await fs.readFile(result.reportPath));
 assert.equal(report.complete, false); assert.equal(report.segments[2].start, 2);
 await add(2, now + 3);
 await assert.rejects(mergeLatestParts({ dir, token: scan.token, allowGaps: true }, ff), /өөрчлөгдсөн/);
 scan = await scanLatestParts(dir);
 assert.equal(scan.ambiguous, true);
 await assert.rejects(mergeLatestParts({ dir, token: scan.token, allowGaps: true }, ff), /Ижил дугаартай/);
});
