const fs = require('fs');
const path = require('path');
const srtParser = require('../electron/srt-parser.js');

const srtPath = 'C:/Users/Gavl/Downloads/[English (auto-generated)] When a Top Assassin Is Reborn as a Schoolboy! - Manhwa Recap [DownSub.com].srt';
const englishSrt = srtParser.reconstructSentences(srtParser.parseSrtFile(srtPath));

const alignmentsPath = path.join(__dirname, '../full_story_alignments.json');
const rawAlignments = JSON.parse(fs.readFileSync(alignmentsPath, 'utf8'));
const alignments = JSON.parse(JSON.stringify(rawAlignments));

alignments[21].matchedSrtId = 11;
alignments[35].matchedSrtId = 18;
alignments[53].matchedSrtId = 27;

let lastSrt = 1;
for (let i = 0; i < alignments.length; i++) {
  if (alignments[i].matchedSrtId < lastSrt) {
    alignments[i].matchedSrtId = lastSrt;
  } else {
    lastSrt = alignments[i].matchedSrtId;
  }
}

const srtMap = new Map();
englishSrt.forEach(s => srtMap.set(s.id, []));
alignments.forEach(a => {
  if (srtMap.has(a.matchedSrtId)) {
    srtMap.get(a.matchedSrtId).push(a);
  }
});

const sceneTimings = [];
for (let i = 0; i < englishSrt.length; i++) {
  const scene = englishSrt[i];
  const sents = srtMap.get(scene.id);
  const rawStart = sents[0].audioStart;
  const rawEnd = sents[sents.length - 1].audioEnd;
  sceneTimings.push({ scene, sents, rawStart, rawEnd });
}

// Find scene 17 in sceneTimings
const sc17 = sceneTimings.find(st => st.scene.id === 17);
console.log('--- SCENE 17 IN sceneTimings ---');
console.log('scene id:', sc17.scene.id);
console.log('scene start:', sc17.scene.start);
console.log('scene end:', sc17.scene.end);
console.log('scene text:', sc17.scene.text);
console.log('sents count:', sc17.sents.length);
console.log('sents[0]:', sc17.sents[0]);
