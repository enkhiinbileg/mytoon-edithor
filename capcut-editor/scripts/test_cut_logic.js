const fs = require('fs');
const path = require('path');
const srtParser = require('../electron/srt-parser.js');

const srtPath = 'C:/Users/Gavl/Downloads/[English (auto-generated)] When a Top Assassin Is Reborn as a Schoolboy! - Manhwa Recap [DownSub.com].srt';
const englishSrt = srtParser.reconstructSentences(srtParser.parseSrtFile(srtPath));

// Check what recap-auto-cut.js is doing!
const recapAutoCut = require('../electron/recap-auto-cut.js');
console.log('recap-auto-cut loaded');

// Let's inspect the cut generation logic
const alignmentsPath = path.join(__dirname, '../full_story_alignments.json');
const rawAlignments = JSON.parse(fs.readFileSync(alignmentsPath, 'utf8'));
const alignments = JSON.parse(JSON.stringify(rawAlignments));

// Apply curated semantic fixes like build_flawless_timeline.js and recap-auto-cut.js:
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

for (let id = 10; id <= 20; id++) {
  const scene = englishSrt.find(s => s.id === id);
  const sents = srtMap.get(id) || [];
  console.log(`SRT #${id}: video[${scene.start.toFixed(2)} - ${scene.end.toFixed(2)}] | sents: ${sents.length} | first mn: "${sents[0]?.mongolianText?.slice(0, 30)}"`);
}
