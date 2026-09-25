const fs = require('fs');
const path = require('path');
const srtParser = require('../electron/srt-parser.js');

const uid = () => Math.random().toString(36).slice(2, 10);

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

const videoClips = [];
let curTimelineStart = 0;
const effVoiceDuration = 4721.55;
const videoDuration = 4443.766667;

for (let i = 0; i < sceneTimings.length; i++) {
  const item = sceneTimings[i];
  const nextItem = sceneTimings[i + 1];

  const tStart = (i === 0) ? 0 : curTimelineStart;
  const tEnd = nextItem ? Math.max(tStart + 0.3, nextItem.rawStart) : effVoiceDuration;
  const cutDur = Math.max(0.3, tEnd - tStart);
  curTimelineStart = tEnd;

  const sStart = Math.max(0, Math.min(videoDuration - 0.4, item.scene.start));
  const sEnd = Math.max(sStart + 0.3, Math.min(videoDuration, item.scene.end));
  const enDur = Math.max(0.3, sEnd - sStart);

  const firstSentence = item.sents[0] || {};

  if (cutDur > enDur + 0.4) {
    videoClips.push({
      clipIndex: videoClips.length,
      sceneId: item.scene.id,
      type: 'motion',
      start: tStart,
      inPoint: sStart,
      outPoint: sEnd,
      label: `[#${item.scene.id}] ${firstSentence.mongolianText ? firstSentence.mongolianText.slice(0, 30) : ''}`
    });
    videoClips.push({
      clipIndex: videoClips.length,
      sceneId: item.scene.id,
      type: 'freeze',
      start: tStart + enDur,
      inPoint: sEnd,
      outPoint: sEnd + (cutDur - enDur),
      label: `[#${item.scene.id} ❄️ Freeze]`
    });
  } else {
    videoClips.push({
      clipIndex: videoClips.length,
      sceneId: item.scene.id,
      type: 'motion',
      start: tStart,
      inPoint: sStart,
      outPoint: sStart + cutDur,
      label: `[#${item.scene.id}] ${firstSentence.mongolianText ? firstSentence.mongolianText.slice(0, 30) : ''}`
    });
  }
}

console.log('--- DRY RUN videoClips 20 to 30 ---');
for (let k = 20; k <= 30; k++) {
  console.log(videoClips[k]);
}
