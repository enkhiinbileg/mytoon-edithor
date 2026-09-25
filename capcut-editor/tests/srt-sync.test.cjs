'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const srtParser = require('../electron/srt-parser');
const bilingualAlign = require('../electron/bilingual-align');

const sampleSrt = `
1
00:00:01,250 --> 00:00:04,800
In a world full of monsters and dungeons, one hunter awakened.

2
00:00:04,900 --> 00:00:08,200
His name was Sung Jinwoo, known as the weakest E-rank hunter.

3
00:00:08,500 --> 00:00:12,100
Suddenly, a blue system screen appeared before his eyes.
`;

console.log('1. Testing SRT Parser...');
const entries = srtParser.parseSrt(sampleSrt);
assert.equal(entries.length, 3, 'Expected 3 subtitle entries');
assert.equal(entries[0].start, 1.25);
assert.equal(entries[0].end, 4.8);
assert.equal(entries[0].text, 'In a world full of monsters and dungeons, one hunter awakened.');
assert.equal(srtParser.formatTimestamp(83.45), '00:01:23,450');
console.log('✓ SRT Parser passed with 100% accuracy.');

console.log('2. Testing Proportional Alignment...');
const mnSegments = [
  { id: 0, start: 0.0, end: 3.8, text: 'Мангас болон шоронгоор дүүрсэн ертөнцөд нэгэн анчин сэрэв.' },
  { id: 1, start: 3.8, end: 7.5, text: 'Түүнийг хамгийн сул дорой Е зэрэглэлийн анчин Сон Жин Ү гэдэг байлаа.' },
  { id: 2, start: 7.5, end: 11.2, text: 'Гэнэт түүний нүдний өмнө цэнхэр системийн цонх гарч ирэв.' }
];

const aligned = bilingualAlign.alignProportional(mnSegments, entries);
assert.equal(aligned.length, 3, 'Expected 3 aligned segments');
assert.equal(aligned[0].matchedSrtId, 1);
assert.equal(aligned[0].videoStart, 1.25);
assert.equal(aligned[1].matchedSrtId, 2);
assert.equal(aligned[2].matchedSrtId, 3);
console.log('✓ Proportional Alignment passed successfully.');

console.log('3. Testing Sentence Reconstruction (Fragmented Auto-sub Stitcher)...');
const fragmentedSrt = `
1
00:00:00,000 --> 00:00:02,200
Gungnir is the John Wick of his story,

2
00:00:02,200 --> 00:00:03,760
maintaining his position as the most

3
00:00:03,760 --> 00:00:05,680
terrifying legendary assassin the world

4
00:00:05,680 --> 00:00:07,600
has ever known.

5
00:00:07,800 --> 00:00:10,000
But surprisingly, he became a student.
`;
const parsedFrag = srtParser.parseSrt(fragmentedSrt);
assert.equal(parsedFrag.length, 5, 'Expected 5 fragmented lines');
const stitched = srtParser.reconstructSentences(parsedFrag);
assert.equal(stitched.length, 2, 'Expected 2 stitched complete sentences');
assert.equal(stitched[0].start, 0.0);
assert.equal(stitched[0].end, 7.6);
assert.equal(stitched[0].text, 'Gungnir is the John Wick of his story, maintaining his position as the most terrifying legendary assassin the world has ever known.');
assert.equal(stitched[1].start, 7.8);
assert.equal(stitched[1].end, 10.0);
assert.equal(stitched[1].text, 'But surprisingly, he became a student.');
console.log('✓ Sentence Reconstruction passed with 100% accuracy.');

console.log('ALL SRT-SYNC UNIT TESTS PASSED!');
