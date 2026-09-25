const fs = require('fs');
const srtParser = require('../electron/srt-parser.js');

const fileA = 'C:/Users/Gavl/Downloads/When a Top Assassin Is Reborn as a Schoolboy! - Manhwa Recap [English (auto-generated)] [DownloadYoutubeSubtitles.com].srt';
const fileB = 'C:/Users/Gavl/Downloads/[English (auto-generated)] When a Top Assassin Is Reborn as a Schoolboy! - Manhwa Recap [DownSub.com].srt';

const rawA = srtParser.parseSrtFile(fileA);
const rawB = srtParser.parseSrtFile(fileB);

console.log('File A (DownloadYoutubeSubtitles): raw count =', rawA.length);
console.log('File B (DownSub): raw count =', rawB.length);

console.log('\n--- Comparing first 5 raw entries ---');
for (let i = 0; i < 5; i++) {
  console.log(`A[${i}]: [${rawA[i].start}-${rawA[i].end}] "${rawA[i].text}"`);
  console.log(`B[${i}]: [${rawB[i].start}-${rawB[i].end}] "${rawB[i].text}"`);
}
