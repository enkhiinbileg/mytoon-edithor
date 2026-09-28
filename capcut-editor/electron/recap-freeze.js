'use strict';

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { FFMPEG } = require('./ffmpeg');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_WORKERS = 2;
const inFlight = new Map();
const waiting = [];
let activeWorkers = 0;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, {
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(error.killed
          ? 'Freeze-frame extraction or validation timed out.'
          : `FFmpeg could not read the freeze frame: ${(stderr || error.message).trim()}`));
      } else resolve(stdout);
    });
  });
}

// This limit is shared by simultaneous calls, including validation of cache hits.
async function withWorker(work) {
  if (activeWorkers >= MAX_WORKERS) await new Promise((resolve) => waiting.push(resolve));
  else activeWorkers += 1;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else activeWorkers -= 1;
  }
}

async function sourceIdentity(filePath) {
  const actualPath = await fs.realpath(filePath);
  const stat = await fs.stat(actualPath, { bigint: true });
  if (!stat.isFile() || stat.size === 0n) throw new Error('Freeze-frame source must be a nonempty video file.');
  return { actualPath, signature: `${actualPath}\0${stat.size}\0${stat.mtimeNs}` };
}

async function validPng(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 45) return false;
    const handle = await fs.open(filePath, 'r');
    try {
      const header = Buffer.alloc(24);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || !header.subarray(0, 8).equals(PNG_SIGNATURE)
        || header.toString('ascii', 12, 16) !== 'IHDR'
        || !header.readUInt32BE(16) || !header.readUInt32BE(20)) return false;
    } finally {
      await handle.close();
    }
    // A nonempty file/header alone does not prove that the image decodes.
    await run(['-hide_banner', '-loglevel', 'error', '-xerror', '-nostdin',
      '-threads', '1', '-i', filePath, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-']);
    return true;
  } catch {
    return false;
  }
}

function materializeOne(source, timestamp, outputDir) {
  const key = crypto.createHash('sha256')
    .update(`recap-freeze-png-v1\0${source.signature}\0${timestamp}`).digest('hex');
  const imagePath = path.join(outputDir, `${key}.png`);
  if (inFlight.has(imagePath)) return inFlight.get(imagePath);
  const operation = withWorker(async () => {
    if (await validPng(imagePath)) return imagePath;
    const temporaryPath = path.join(outputDir, `.${key}.${crypto.randomUUID()}.partial.png`);
    try {
      // Input seeking is frame accurate while transcoding (FFmpeg accurate_seek).
      // Do not copy a nearby thumbnail/keyframe: it can belong to another scene.
      await run(['-hide_banner', '-loglevel', 'error', '-xerror', '-nostdin', '-y',
        '-threads', '1', '-ss', String(timestamp), '-accurate_seek', '-i', source.actualPath,
        '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
        '-c:v', 'png', '-threads', '1', '-update', '1', temporaryPath]);
      if (!(await validPng(temporaryPath))) {
        throw new Error(`No decodable video frame exists at ${timestamp} seconds.`);
      }
      // Publishing only complete images keeps interrupted jobs out of the cache.
      await fs.rename(temporaryPath, imagePath);
      return imagePath;
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  });
  inFlight.set(imagePath, operation);
  operation.then(() => inFlight.delete(imagePath), () => inFlight.delete(imagePath));
  return operation;
}

/**
 * Create actual still-image media for recap holds. outputDir must be an absolute,
 * persistent project asset directory: returned paths are saved in the project.
 * Returns an entry for every distinct requested timestamp, or rejects the job.
 */
async function materializeFreezeFrames({ video, timestamps, outputDir }, progress = () => {}) {
  if (!video || typeof video.path !== 'string' || !path.isAbsolute(video.path)) {
    throw new Error('An absolute source video path is required for freeze frames.');
  }
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) {
    throw new Error('A persistent, absolute freeze-frame output directory is required.');
  }
  if (!Array.isArray(timestamps)) throw new Error('Freeze-frame timestamps must be an array.');
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    throw new Error('The source video duration must be known before creating freeze frames.');
  }
  const unique = [...new Set(timestamps)];
  for (const timestamp of unique) {
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp >= video.duration) {
      throw new Error(`Freeze-frame timestamp ${timestamp} is outside the source video.`);
    }
  }
  const source = await sourceIdentity(video.path);
  const destination = path.resolve(outputDir);
  await fs.mkdir(destination, { recursive: true });
  let completed = 0;
  const settled = await Promise.allSettled(unique.map(async (timestamp) => {
    const imagePath = await materializeOne(source, timestamp, destination);
    completed += 1;
    progress({ stage: 'freeze', completed, total: unique.length, timestamp });
    return [timestamp, imagePath];
  }));
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  if ((await sourceIdentity(video.path)).signature !== source.signature) {
    throw new Error('The source video changed while freeze frames were being created. Run Auto-Cut again.');
  }
  return new Map(settled.map((result) => result.value));
}

module.exports = { materializeFreezeFrames };
