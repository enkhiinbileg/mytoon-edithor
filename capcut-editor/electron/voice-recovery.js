'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

// Legacy parts have no job ID. Keep the latest time cluster only, and refuse
// ambiguous duplicate indices instead of filling holes from another attempt.
async function scanLatestParts(dir) {
  const names = await fs.readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const files = [];
  for (const name of names) {
    const match = /^pool_part_(\d+)_(\d{13})_([a-z0-9]+)\.mp3$/i.exec(name);
    if (!match) continue;
    const stat = await fs.stat(path.join(dir, name));
    if (!stat.isFile()) continue;
    files.push({ name, index: Number(match[1]), requestedAt: Number(match[2]), size: stat.size, modifiedAt: stat.mtimeMs });
  }
  files.sort((a, b) => a.requestedAt - b.requestedAt || a.index - b.index);
  let start = 0;
  for (let i = 1; i < files.length; i++) {
    if (files[i].requestedAt - files[i - 1].requestedAt > 30 * 60 * 1000) start = i;
  }
  const parts = files.slice(start).sort((a, b) => a.index - b.index || a.requestedAt - b.requestedAt);
  const indices = new Set(parts.map(p => p.index));
  const missing = [];
  const maxIndex = parts.length ? Math.max(...indices) : -1;
  if (maxIndex > 100000) throw new Error('Хэсгийн дугаар хэт том байна.');
  for (let i = 0; i <= maxIndex; i++) if (!indices.has(i)) missing.push(i + 1);
  const ambiguous = indices.size !== parts.length;
  const token = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return { token, parts, missing, ambiguous, inferred: true,
    startedAt: parts.length ? Math.min(...parts.map(p => p.requestedAt)) : null,
    endedAt: parts.length ? Math.max(...parts.map(p => p.modifiedAt)) : null };
}

async function mergeLatestParts({ dir, outDir = dir, token, allowGaps = false }, ff) {
  const scan = await scanLatestParts(dir);
  if (token !== scan.token) throw new Error('Файлууд өөрчлөгдсөн байна. Дахин шалгана уу.');
  if (!scan.parts.length) throw new Error('Нэгтгэх аудио хэсэг олдсонгүй.');
  if (scan.ambiguous) throw new Error('Ижил дугаартай олон файл байна. Өөр оролдлогууд холилдсон байж болзошгүй тул автоматаар нэгтгэсэнгүй.');
  if (scan.missing.length && !allowGaps) throw new Error(`Дутуу хэсэг: ${scan.missing.join(', ')}. Зөвхөн байгаа хэсгүүдийг нэгтгэх сонголтыг ашиглана уу.`);
  if (scan.parts.some(p => !p.size || Date.now() - p.modifiedAt < 10000)) throw new Error('Хоосон эсвэл бичигдэж буй аудио байна. Үүсгэх ажил зогссоны дараа дахин шалгана уу.');
  const segments = [];
  let totalDuration = 0;
  for (const part of scan.parts) {
    const info = await ff.probe(path.join(dir, part.name));
    if (!info.hasAudio || !(info.duration > 0)) throw new Error(`Аудио эвдэрсэн эсвэл хоосон: ${part.name}`);
    segments.push({ part: part.index + 1, file: part.name, start: totalDuration, end: totalDuration + info.duration });
    totalDuration += info.duration;
  }
  if ((await scanLatestParts(dir)).token !== token) throw new Error('Нэгтгэх үед эх файлууд өөрчлөгдлөө. Дахин шалгана уу.');
  await fs.mkdir(outDir, { recursive: true });
  const base = `recovered_partial_${new Date(scan.startedAt).toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;
  const audioPath = path.join(outDir, base + '.mp3');
  await ff.concatAudioFiles(scan.parts.map(p => path.join(dir, p.name)), audioPath);
  const output = await ff.probe(audioPath);
  if (!output.hasAudio || Math.abs(output.duration - totalDuration) > Math.max(2, scan.parts.length * .15)) {
    throw new Error('Нэгтгэсэн аудионы үргэлжлэх хугацаа таарахгүй байна. Үр дүнг бүрэн гэж үзэж болохгүй.');
  }
  const reportPath = path.join(outDir, base + '.json');
  await fs.writeFile(reportPath, JSON.stringify({ complete: false,
    note: 'Зөвхөн байгаа хэсгүүдийг нэгтгэв. Хуучин файлуудад ажлын ID, нийт хэсгийн тоо байхгүй тул бүлгийг хугацаагаар таамагласан. Дутуу хэсгийг нөхөөгүй. Төгсгөлийн хэсгүүд бүрэн эсэх тодорхойгүй.',
    missingParts: scan.missing, duration: output.duration, segments }, null, 2));
  return { audioPath, reportPath, duration: output.duration, count: segments.length, missing: scan.missing };
}
async function scanAudioFolder(dir) {
  const parts = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)$/i.test(entry.name)) continue;
    const stat = await fs.stat(path.join(dir, entry.name));
    parts.push({ name: entry.name, size: stat.size, modifiedAt: stat.mtimeMs });
  }
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  parts.sort((a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const token = createHash('sha256').update(JSON.stringify({ dir: path.resolve(dir), parts })).digest('hex');
  return { dir, parts, token };
}

async function mergeAudioFolder({ dir, token, output }, ff) {
  const scan = await scanAudioFolder(dir);
  if (scan.token !== token) throw new Error('Хавтас өөрчлөгдсөн байна. Дахин сонгоно уу.');
  if (!scan.parts.length) throw new Error('Хавтсанд аудио файл олдсонгүй.');
  if (scan.parts.some(p => path.resolve(dir, p.name).toLowerCase() === path.resolve(output).toLowerCase())) throw new Error('Эх аудио файлыг дарж хадгалах боломжгүй. Өөр нэр сонгоно уу.');
  const temp = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'cutline-merge-'));
  try {
    let duration = 0;
    const lines = [];
    for (const [index, part] of scan.parts.entries()) {
      const source = path.join(dir, part.name);
      const info = await ff.probe(source);
      if (!info.hasAudio || !(info.duration > 0)) throw new Error(`Унших боломжгүй аудио: ${part.name}`);
      duration += info.duration;
      // Normalize mixed formats before concatenation; one input at a time bounds memory.
      const wav = path.join(temp, `${index}.wav`);
      await ff.run(ff.FFMPEG, ['-v', 'error', '-y', '-i', source, '-map', '0:a:0', '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', wav]);
      lines.push(`file '${wav.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    }
    if ((await scanAudioFolder(dir)).token !== token) throw new Error('Эх файлууд өөрчлөгдлөө. Дахин сонгоно уу.');
    const list = path.join(temp, 'list.txt');
    await fs.writeFile(list, lines.join('\n'));
    const result = path.join(temp, 'merged.mp3');
    await ff.run(ff.FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'libmp3lame', '-b:a', '192k', result]);
    const info = await ff.probe(result);
    if (!info.hasAudio || Math.abs(info.duration - duration) > Math.max(2, scan.parts.length * .2)) throw new Error('Нэгтгэсэн аудионы хугацаа таарахгүй байна.');
    await fs.copyFile(result, output);
    return { audioPath: output, count: scan.parts.length, duration: info.duration };
  } finally {
    const tempRoot = path.resolve(require('node:os').tmpdir());
    if (path.dirname(path.resolve(temp)) !== tempRoot || !path.basename(temp).startsWith('cutline-merge-')) throw new Error('Unexpected temporary directory');
    await fs.rm(temp, { recursive: true, force: true });
  }
}
module.exports = { scanLatestParts, mergeLatestParts, scanAudioFolder, mergeAudioFolder };
