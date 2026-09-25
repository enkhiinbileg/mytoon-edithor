const fs = require('fs');
const path = require('path');
const srtParser = require('../electron/srt-parser.js');

const srtPath = 'C:/Users/Gavl/Downloads/[English (auto-generated)] When a Top Assassin Is Reborn as a Schoolboy! - Manhwa Recap [DownSub.com].srt';
const englishSrt = srtParser.reconstructSentences(srtParser.parseSrtFile(srtPath));

const al = JSON.parse(fs.readFileSync('capcut-editor/full_story_alignments.json', 'utf8'));

console.log(`Loaded ${al.length} alignments and ${englishSrt.length} English SRT scenes.`);

// Check for any scene jumps or non-monotonicities
const issues = [];
for (let i = 0; i < al.length; i++) {
  const a = al[i];
  const prev = al[i - 1];
  if (prev && a.videoStart < prev.videoStart) {
    issues.push({ index: i, type: 'backward_jump', prev: prev.videoStart, curr: a.videoStart, mn: a.mongolianText });
  }
}

console.log('Total issues found:', issues.length);
issues.forEach(iss => console.log(iss));
