'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ff = require('./ffmpeg');
const work = require('./recap-work');
const toolsDir = () => path.join(app.getPath('userData'),'recap-tools');
function binary() {
  const bundled = path.join(process.resourcesPath || '', 'recap-tools','yt-dlp.exe');
  return [process.env.YTDLP_PATH,path.join(toolsDir(),'yt-dlp.exe'),bundled,path.join(__dirname,'..','runtime-tools','yt-dlp.exe')].find(p=>p&&fs.existsSync(p));
}
async function install() {
  fs.mkdirSync(toolsDir(),{recursive:true});
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
  const [exe, sums] = await Promise.all([fetch(base+'yt-dlp.exe'),fetch(base+'SHA2-256SUMS')]);
  if (!exe.ok || !sums.ok) throw new Error('Could not download yt-dlp from its official release.');
  const bytes = Buffer.from(await exe.arrayBuffer());
  const expected = (await sums.text()).split('\n').find(l=>/\s\*?yt-dlp\.exe\s*$/.test(l))?.trim().split(/\s+/)[0];
  if (!expected || crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Downloader checksum verification failed.');
  const dest = path.join(toolsDir(),'yt-dlp.exe');
  fs.writeFileSync(dest+'.part',bytes); fs.renameSync(dest+'.part',dest);
  return {ready:true};
}
function validateUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(url.hostname))
    throw new Error('Enter an HTTPS YouTube video link.');
  return url.href;
}
async function download(value, language, signal, progress) {
  const url = validateUrl(value);
  const bin = binary();
  if (!bin) throw new Error('Install the YouTube downloader using Setup downloader.');
  const dir = path.join(app.getPath('userData'),'recap-downloads',work.hash({url,language}).slice(0,20));
  fs.mkdirSync(dir,{recursive:true});
  const cache = path.join(dir,'download.json');
  const saved = work.read(cache);
  if (saved && fs.existsSync(saved.source)) return {...saved,cached:true};
  const args = ['--ignore-config','--no-plugin-dirs','--no-remote-components','--no-playlist','--no-simulate','--newline',
    '--js-runtimes','node','--concurrent-fragments','4','--socket-timeout','30','--retries','3',
    '-f','bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*[height<=1080]+ba/b',
    '--merge-output-format','mp4','--write-subs','--sub-format','srt/vtt/best','--sub-langs',/^[a-z]{2}$/.test(language)?language:'en',
    '--print','after_move:filepath','-o',path.join(dir,'source.%(ext)s')];
  if (path.isAbsolute(ff.FFMPEG)) args.push('--ffmpeg-location',path.dirname(ff.FFMPEG));
  args.push('--',url);
  let stdout = '', stderr = '';
  await new Promise((resolve,reject)=>{
    const child = spawn(bin,args,{windowsHide:true,signal});
    child.stdout.on('data',b=>{stdout=(stdout+b).slice(-16000);progress?.({stage:'download',message:b.toString().trim().slice(-180)});});
    child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve():reject(new Error(signal?.aborted?'Download stopped.':stderr || 'Video download failed.')));
  });
  const source = stdout.trim().split(/\r?\n/).reverse().find(p=>path.isAbsolute(p)&&fs.existsSync(p)&&p.startsWith(dir+path.sep));
  if (!source) throw new Error('Downloader did not return a video file.');
  const subtitle = fs.readdirSync(dir).find(f=>/\.(srt|vtt)$/.test(f));
  const result = {source,subtitle:subtitle?path.join(dir,subtitle):null};
  work.write(cache,result);
  return result;
}
module.exports = { binary, install, download, validateUrl };
