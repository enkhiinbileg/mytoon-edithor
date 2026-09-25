const fs = require('fs');
const proj = JSON.parse(fs.readFileSync('C:/Users/Gavl/AppData/Roaming/Cutline/projects/proj_mu7979y5.cutline', 'utf8'));
const clips = proj.clips.filter(c => c.trackId === 'v1');

console.log('--- ALL v1 CLIPS 0 TO 30 ---');
for (let i = 0; i < 30; i++) {
  const c = clips[i];
  if (!c) break;
  console.log(`[CLIP ${i}] label: "${c.label}" | start: ${c.start.toFixed(2)}s | inPoint: ${c.inPoint.toFixed(2)}s | outPoint: ${c.outPoint.toFixed(2)}s | srtId: ${c.matchedSrtId}`);
}
