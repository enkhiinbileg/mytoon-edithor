const fs = require('fs');
const proj = JSON.parse(fs.readFileSync('C:/Users/Gavl/AppData/Roaming/Cutline/projects/proj_mu7979y5.cutline', 'utf8'));
const clips = proj.clips.filter(c => c.trackId === 'v1');

console.log('--- CLIPS 15 TO 30 IN CURRENT PROJECT ---');
for (let i = 15; i <= 30; i++) {
  const c = clips[i];
  if (!c) break;
  console.log(`[CLIP ${i}] id:${c.id} start:${c.start.toFixed(2)} in:${c.inPoint.toFixed(2)} out:${c.outPoint.toFixed(2)}`);
  console.log(`  label: ${c.label}`);
  console.log(`  matchedSrtId: ${c.matchedSrtId}`);
  console.log(`  enText: "${c.englishText}"`);
  console.log(`  mnText: "${c.mongolianText}"`);
}
