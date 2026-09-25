const fs = require('fs');
const alignments = JSON.parse(fs.readFileSync('capcut-editor/full_story_alignments.json', 'utf8'));

console.log('--- FIRST 40 ALIGNMENTS IN full_story_alignments.json ---');
for (let i = 0; i < 40; i++) {
  const a = alignments[i];
  if (!a) break;
  console.log(`[#${i}] audio: ${a.audioStart?.toFixed(1)}s - ${a.audioEnd?.toFixed(1)}s | matchedSrtId: ${a.matchedSrtId}`);
  console.log(`   mn: ${a.mongolianText}`);
  console.log(`   en: ${a.englishText}`);
}
