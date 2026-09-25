const srtParser = require('../electron/srt-parser.js');
const srtPath = 'C:/Users/Gavl/Downloads/[English (auto-generated)] When a Top Assassin Is Reborn as a Schoolboy! - Manhwa Recap [DownSub.com].srt';
const srt = srtParser.reconstructSentences(srtParser.parseSrtFile(srtPath));

console.log('--- FIRST 35 ENGLISH SRT SCENES ---');
for (let i = 0; i < 35; i++) {
  console.log(`SRT #${srt[i].id} [${srt[i].start.toFixed(1)}s - ${srt[i].end.toFixed(1)}s]: ${srt[i].text}`);
}
