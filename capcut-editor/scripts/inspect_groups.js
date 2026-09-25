const fs = require('fs');
const alignments = JSON.parse(fs.readFileSync('capcut-editor/full_story_alignments.json', 'utf8'));

const sceneGroups = [];
let curGroup = null;

for (let i = 0; i < alignments.length; i++) {
  const a = alignments[i];
  if (!curGroup || curGroup.matchedSrtId !== a.matchedSrtId) {
    if (curGroup) sceneGroups.push(curGroup);
    curGroup = {
      matchedSrtId: a.matchedSrtId,
      videoStart: a.videoStart,
      videoEnd: a.videoEnd,
      englishText: a.englishText,
      sentences: [a],
      audioStart: a.audioStart,
      audioEnd: a.audioEnd
    };
  } else {
    curGroup.sentences.push(a);
    curGroup.audioEnd = a.audioEnd;
  }
}
if (curGroup) sceneGroups.push(curGroup);

console.log('--- SCENE GROUPS 0 TO 25 ---');
for (let i = 0; i < Math.min(25, sceneGroups.length); i++) {
  const g = sceneGroups[i];
  console.log(`Group idx: ${i} | matchedSrtId: ${g.matchedSrtId} | audioStart: ${g.audioStart.toFixed(1)}s | videoStart: ${g.videoStart?.toFixed(1)}s | mn: "${g.sentences[0].mongolianText.slice(0, 30)}"`);
}
