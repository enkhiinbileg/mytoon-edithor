const fs = require('fs');
const srtParser = require('../electron/srt-parser.js');

const srtPath = 'C:/Users/Gavl/Downloads/[English (auto-generated)] When a Top Assassin Is Reborn as a Schoolboy! - Manhwa Recap [DownSub.com].srt';
const englishSrt = srtParser.reconstructSentences(srtParser.parseSrtFile(srtPath));

const rawAlignments = JSON.parse(fs.readFileSync('capcut-editor/full_story_alignments.json', 'utf8'));
const alignments = JSON.parse(JSON.stringify(rawAlignments));

const srtMap = new Map();
englishSrt.forEach(s => srtMap.set(s.id, []));
alignments.forEach(a => {
  if (srtMap.has(a.matchedSrtId)) {
    srtMap.get(a.matchedSrtId).push(a);
  }
});

console.log('--- SCENES 1 TO 25 IN srtMap ---');
for (let id = 1; id <= 25; id++) {
  const scene = englishSrt.find(s => s.id === id);
  const sents = srtMap.get(id) || [];
  console.log(`\n======================================================`);
  console.log(`SRT #${id} [video: ${scene.start.toFixed(1)}s - ${scene.end.toFixed(1)}s] (${(scene.end - scene.start).toFixed(1)}s)`);
  console.log(`EN TEXT: "${scene.text}"`);
  console.log(`MATCHED MN SENTS COUNT: ${sents.length}`);
  if (sents.length > 0) {
    console.log(`AUDIO RANGE: ${sents[0].audioStart.toFixed(1)}s - ${sents[sents.length - 1].audioEnd.toFixed(1)}s`);
    sents.forEach(s => {
      console.log(`   - [mnId: ${s.mongolianId}] (${s.audioStart.toFixed(1)}s-${s.audioEnd.toFixed(1)}s): "${s.mongolianText}"`);
    });
  } else {
    console.log(`   *** EMPTY (0 sentences matched!) ***`);
  }
}
