const fs = require('fs');
const path = require('path');
const srtParser = require('../electron/srt-parser.js');

const srtPath = 'C:/Users/Gavl/Downloads/[English (auto-generated)] When a Top Assassin Is Reborn as a Schoolboy! - Manhwa Recap [DownSub.com].srt';
const englishSrt = srtParser.reconstructSentences(srtParser.parseSrtFile(srtPath));

const rawAlignments = JSON.parse(fs.readFileSync('capcut-editor/full_story_alignments.json', 'utf8'));
const alignments = JSON.parse(JSON.stringify(rawAlignments));

// In build_flawless_timeline.js:
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
  sceneTimings.push({
    i,
    sceneId: scene.id,
    sceneStart: scene.start,
    sceneEnd: scene.end,
    rawStart,
    rawEnd,
    firstMn: sents[0].mongolianText.slice(0, 30),
    enText: scene.text.slice(0, 40)
  });
}

console.log('--- sceneTimings 10 to 20 ---');
for (let i = 10; i <= 20; i++) {
  console.log(sceneTimings[i]);
}
