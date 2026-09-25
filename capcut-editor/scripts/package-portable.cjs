const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname,'..');
const output = path.join(root,'release','Cutline');
const appDir = path.join(output,'resources','app');
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  try {
    fs.cpSync(path.join(root,'node_modules','electron','dist'),output,{recursive:true,force:false,errorOnExist:false,filter:source=>path.basename(source)!=='default_app.asar'});
  } catch {}
  fs.mkdirSync(path.join(appDir,'electron'),{recursive:true});
  const runtime = path.join(root,'runtime-tools');
  const bundled = path.join(output,'resources','recap-tools');
  fs.mkdirSync(bundled,{recursive:true});
  for (const name of ['ffmpeg.exe','ffprobe.exe','yt-dlp.exe','ggml-base.bin','whisper','FFmpeg-LICENSE.txt','Whisper-LICENSE.txt','THIRD-PARTY.md']) {
    const source = path.join(runtime,name);
    const dest = path.join(bundled,name);
    if (fs.existsSync(source) && !fs.existsSync(dest)) {
      try {
        fs.cpSync(source, dest, {recursive:true});
      } catch (err) {
        console.warn(`[package] skipped copying ${name}:`, err.message);
      }
    }
  }
  await esbuild.build({entryPoints:[path.join(root,'electron','main.js')],outfile:path.join(appDir,'electron','main.js'),bundle:true,platform:'node',target:'node20',external:['electron'],logLevel:'info'});
  fs.copyFileSync(path.join(root,'electron','preload.js'),path.join(appDir,'electron','preload.js'));
  fs.cpSync(path.join(root,'dist'),path.join(appDir,'dist'),{recursive:true});
  if (fs.existsSync(path.join(root, 'full_story_alignments.json'))) {
    fs.copyFileSync(path.join(root, 'full_story_alignments.json'), path.join(appDir, 'full_story_alignments.json'));
    fs.copyFileSync(path.join(root, 'full_story_alignments.json'), path.join(output, 'resources', 'full_story_alignments.json'));
  }
  if (fs.existsSync(path.join(root, 'capcut_auto_captions.json'))) {
    fs.copyFileSync(path.join(root, 'capcut_auto_captions.json'), path.join(appDir, 'capcut_auto_captions.json'));
    fs.copyFileSync(path.join(root, 'capcut_auto_captions.json'), path.join(output, 'resources', 'capcut_auto_captions.json'));
  }
  fs.writeFileSync(path.join(appDir,'package.json'),JSON.stringify({name:'capcut-editor',productName:'Cutline',version:'0.2.0',main:'electron/main.js'},null,2));
  try {
    fs.copyFileSync(path.join(output,'electron.exe'),path.join(output,'Cutline.exe'));
  } catch {}
  console.log('Portable app: '+path.join(output,'Cutline.exe'));
})().catch(e=>{console.error(e);process.exitCode=1;});
