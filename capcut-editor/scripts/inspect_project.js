const fs = require('fs');
const proj = JSON.parse(fs.readFileSync('C:/Users/Gavl/AppData/Roaming/Cutline/projects/proj_mu7979y5.cutline', 'utf8'));
const clips = proj.clips.filter(c => c.trackId === 'v1');
console.log('Total v1 clips in project:', clips.length);

for (let i = 10; i < 25; i++) {
  const c = clips[i];
  if (!c) continue;
  console.log(`[CLIP ${i}] label: ${c.label}`);
  console.log(`   srtId: ${c.matchedSrtId} | timeline: ${c.start.toFixed(2)}s | inPoint: ${c.inPoint.toFixed(2)}s | outPoint: ${c.outPoint.toFixed(2)}s`);
  console.log(`   sourceStart: ${c.sourceStart} | sourceEnd: ${c.sourceEnd}`);
  console.log(`   en: ${(c.englishText || '').slice(0, 80)}...`);
  console.log(`   mn: ${(c.mongolianText || '').slice(0, 80)}...`);
}
