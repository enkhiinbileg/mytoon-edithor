'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {autoCutByEnglishSrt}=require('../electron/recap-auto-cut');
const {validateProject,atomicWrite}=require('../electron/project-store');
const ff=require('../electron/ffmpeg');

async function repair(projectPath,srtPath,outputPath) {
 if(!projectPath || !srtPath || !outputPath) throw Error('Usage: node scripts/repair-recap.cjs source.cutline english.srt output.cutline');
 if(path.resolve(projectPath)===path.resolve(outputPath)) throw Error('Use a separate output project to preserve the original.');
 const project=validateProject(JSON.parse(fs.readFileSync(projectPath,'utf8')));
 const outputDir=path.join(path.dirname(path.resolve(outputPath)),'recap-freeze');
 const started=Date.now();let lastUpdate=0;
 // Probe the actual referenced source files before trusting stored media metadata.
 const ids=new Set(project.clips.filter(c=>c.trackId==='v1'||c.trackId==='a1').map(c=>c.mediaId));
 for(const id of ids) {
   const media=project.media.find(m=>m.id===id);
   if(!media || media.kind==='image') continue;
   const actual=await ff.probe(media.path);
   if(Math.abs(actual.duration-media.duration)>0.1) throw Error(`Media duration changed: ${media.name}. Reimport it before repairing.`);
 }
 const result=await autoCutByEnglishSrt({projectData:project,captions:project.clips.filter(c=>c.trackId==='ov1'&&c.kind==='text'),srtPath,outputDir},p=>{
   if(Date.now()-lastUpdate>3000 || p.stage==='done'){console.log(p.message || p.stage);lastUpdate=Date.now();}
 });
 const repaired=validateProject({...project,media:[...project.media,...result.newMedia],clips:[...project.clips.filter(c=>c.trackId!=='v1'),...result.videoClips]});
 atomicWrite(path.resolve(outputPath),repaired);
 const report={...result.report,motionCount:result.motionCount,freezeCount:result.freezeCount,seconds:(Date.now()-started)/1000,outputPath:path.resolve(outputPath)};
 atomicWrite(path.resolve(outputPath)+'.report.json',report);
 console.log(JSON.stringify(report,null,2));
 return report;
}
if(require.main===module) repair(...process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={repair};
