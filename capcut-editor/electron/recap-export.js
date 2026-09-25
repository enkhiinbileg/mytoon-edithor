'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const ff = require('./ffmpeg');
const work = require('./recap-work');

function run(bin, args, signal) {
  work.check(signal);
  return new Promise((resolve, reject) => execFile(bin, args,
    { windowsHide: true, signal, maxBuffer: 4 * 1024 * 1024 },
    (err, out, stderr) => err ? reject(new Error(signal?.aborted ? 'Stopped; completed work saved.' : (stderr || err.message))) : resolve(out)));
}

async function exportRecap({ source, clips, duration, outPath, dir, signal, onProgress }) {
  if (path.resolve(source).toLowerCase() === path.resolve(outPath).toLowerCase()) throw new Error('Choose an output different from the source video.');
  if (!(duration > 0) || !Number.isFinite(duration)) throw new Error('Invalid video duration.');
  const sorted = [...clips].sort((a,b) => a.start-b.start);
  if (!sorted.length) throw new Error('No narration to export.');
  for (let i=0; i<sorted.length; i++) {
    const c = sorted[i], end = Math.min(duration, sorted[i+1]?.start ?? duration);
    if (!(c.start >= 0 && c.duration > 0 && c.start < duration) || c.start+c.duration > end+0.06)
      throw new Error(`Line ${c.id} needs a shorter translation before export.`);
  }
  const blockDir = path.join(dir, 'mix-' + work.hash({ clips: sorted, duration }).slice(0,16));
  fs.mkdirSync(blockDir, { recursive: true });
  const blocks = Array.from({ length: Math.ceil(sorted.length/24) }, (_,i) => sorted.slice(i*24,i*24+24));
  const audio = path.join(blockDir,'mongolian.m4a');
  if (!fs.existsSync(audio)) {
  let completed = 0;
  const files = await work.map(blocks, 2, async (group, b) => {
    const start = b === 0 ? 0 : group[0].start;
    const end = blocks[b+1]?.[0].start ?? duration;
    const file = path.join(blockDir, `${b}.wav`);
    if (!fs.existsSync(file)) {
      const tmp = file + '.part.wav';
      const args = ['-hide_banner','-loglevel','error','-y'];
      group.forEach(c => args.push('-i',c.file));
      const filters = group.map((c,i) => {
        const limit = Math.min(group[i+1]?.start ?? end,end)-c.start;
        return `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,atrim=duration=${limit},asetpts=PTS-STARTPTS,adelay=${Math.round((c.start-start)*48000)}S:all=1[a${i}]`;
      });
      filters.push(group.map((_,i)=>`[a${i}]`).join('')+`amix=inputs=${group.length}:normalize=0,apad,atrim=duration=${end-start}[mix]`);
      args.push('-filter_complex',filters.join(';'),'-map','[mix]','-c:a','pcm_s16le','-ar','48000','-ac','1',tmp);
      try { await run(ff.FFMPEG,args,signal); fs.renameSync(tmp,file); }
      finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    }
    onProgress?.({ stage: 'mix', done: ++completed, total: blocks.length });
    return file;
  },signal);
  // Generated numeric basenames keep the concat manifest independent of user paths.
  const list = path.join(blockDir,'audio.ffconcat');
  fs.writeFileSync(list,'ffconcat version 1.0\n'+files.map((_,i)=>`file '${i}.wav'`).join('\n'));
  if (!fs.existsSync(audio)) {
    const tmp = path.join(blockDir,'audio.part.m4a');
    try {
      await run(ff.FFMPEG,['-hide_banner','-loglevel','error','-y','-f','concat','-safe','1','-i',list,'-c:a','aac','-b:a','160k',tmp],signal);
      fs.renameSync(tmp,audio);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  }
  // The encoded narration is the checkpoint; discard large intermediate PCM blocks.
  for (let i=0;i<blocks.length;i++) { try { fs.unlinkSync(path.join(blockDir,`${i}.wav`)); } catch {} }
  onProgress?.({stage:'export',done:0,total:1});
  const extension = path.extname(outPath).toLowerCase();
  if (!['.mp4','.mkv'].includes(extension)) throw new Error('Fast export supports MP4 or MKV.');
  const tmp = path.join(path.dirname(outPath), `.${path.basename(outPath,extension)}-${Date.now()}.part${extension}`);
  try {
    const args = ['-hide_banner','-loglevel','error','-y','-i',source,'-i',audio,'-map','0:v:0','-map','1:a:0','-c','copy','-t',String(duration),'-map_metadata','-1'];
    if (extension === '.mp4') args.push('-movflags','+faststart');
    args.push(tmp);
    await run(ff.FFMPEG,args,signal);
    const info = await ff.probe(tmp);
    if (!info.hasAudio || !info.hasVideo || Math.abs(info.duration-duration)>0.25) throw new Error('Export verification failed: duration or streams differ.');
    fs.renameSync(tmp,outPath);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return { path: outPath, audioPath: audio };
}
module.exports = { exportRecap, run };
