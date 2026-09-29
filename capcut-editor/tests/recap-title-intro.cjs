'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { geminiAlign } = require('../electron/recap-alignment');
const { autoCutByEnglishSrt } = require('../electron/recap-auto-cut');
const { validateProject } = require('../electron/project-store');

function fixture() {
  const captions = [
    { id: 'intro1', start: 0, inPoint: 0, outPoint: 3.85, style: { text: 'Түүнийг шоолдог байлаа. Гэвч тэр бэлтгэл хийж,' } },
    { id: 'intro2', start: 3.85, inPoint: 0, outPoint: 3.07, style: { text: 'хамгийн хүчтэй сэлэмчин болов!' } },
    { id: 'story', start: 6.92, inPoint: 0, outPoint: 4, style: { text: 'Ханхүү хүлэг баатрыг тулаанд дуудав.' } }
  ].map(c => ({ ...c, style: { ...c.style, color: '#fff', background: 'transparent', fontSize: 32 }, kind: 'text', trackId: 'ov1' }));
  return { captions, apiKey: 'test', videoDuration: 20, sourceTitle: 'They laughed at him, but he trains and becomes the strongest swordsman!', englishSrt: [{ id: 1, start: 0.08, end: 8.88, text: 'The prince challenges the knight to a duel.' }] };
}
const matches = () => [0, 1].map(id => ({ id, startId: null, endId: null, confidence: 0, kind: 'title_intro' })).concat({ id: 2, startId: 1, endId: 1, confidence: 0.9, kind: 'matched' });
function mockFetch(rows) {
  return async (_url, options) => ({ ok: true, json: async () => options.method === 'GET'
    ? { models: [{ name: 'models/gemini-test-flash', supportedGenerationMethods: ['generateContent'] }] }
    : { candidates: [{ content: { parts: [{ text: JSON.stringify({ matches: rows }) }] } }] } });
}

test('title-only opening gets a marked hold at the first semantic anchor, not a guessed match', async () => {
  const result = await geminiAlign(fixture(), null, mockFetch(matches()));
  assert.equal(result.alignments.length, 3);
  for (const a of result.alignments.slice(0, 2)) {
    assert.equal(a.mode, 'title-intro-hold'); assert.equal(a.videoStart, 0.08);
    assert.equal(a.confidence, 0); assert.equal(a.englishText, '');
  }
  assert.equal(result.alignments[2].videoStart, 0.08);
  assert.match(result.warnings[0], /2 хадмал.*6.92 секунд/);
});

for (const variant of ['no-title', 'ordinary-unmatched', 'long-intro', 'weak-anchor', 'late-anchor', 'all-unmatched', 'interior-title']) test(`does not disguise ${variant} as a title hold`, async () => {
  const spec = fixture(), rows = matches();
  if (variant === 'no-title') delete spec.sourceTitle;
  if (variant === 'ordinary-unmatched') rows[0].kind = 'unmatched';
  if (variant === 'long-intro') spec.captions[2].start = 16;
  if (variant === 'weak-anchor') rows[2].confidence = 0.3;
  if (variant === 'late-anchor') { spec.englishSrt = Array.from({ length: 5 }, (_, i) => ({ id: i+1, start: i*2, end: i*2+1, text: 'Story' })); rows[2].startId = rows[2].endId = 5; }
  if (variant === 'all-unmatched') Object.assign(rows[2], { startId: null, endId: null, kind: 'title_intro' });
  if (variant === 'interior-title') Object.assign(rows[0], { startId: 1, endId: 1, confidence: 0.9, kind: 'matched' });
  await assert.rejects(geminiAlign(spec, null, mockFetch(rows)), /тодорхойгүй/);
});

test('Auto-Cut keeps the title hold separate, starts motion at narration, reports true matches and roundtrips', async () => {
  const spec = fixture();
  const projectData = {
    format: 'cutline-project', version: 1, name: 'Title intro', settings: { width: 160, height: 90, fps: 30 },
    media: [{ id: 'v', name: 'Source', path: 'source.mp4', kind: 'video', duration: 20, width: 160, height: 90, fps: 30, thumbs: [] }, { id: 'a', name: 'Voice', path: 'voice.mp3', kind: 'audio', duration: 10.92, width: 0, height: 0, fps: 0, thumbs: [] }],
    tracks: [{ id: 'v1', name: 'Video', kind: 'video' }, { id: 'a1', name: 'Voice', kind: 'audio' }, { id: 'ov1', name: 'Captions', kind: 'overlay' }],
    clips: [{ id: 'vclip', kind: 'av', mediaId: 'v', trackId: 'v1', start: 0, inPoint: 0, outPoint: 20 }, { id: 'aclip', kind: 'av', mediaId: 'a', trackId: 'a1', start: 0, inPoint: 0, outPoint: 10.92 }, ...spec.captions]
  };
  const before = JSON.stringify(projectData);
  const result = await autoCutByEnglishSrt({ projectData, captions: spec.captions, geminiApiKey: 'test', srtPath: spec.sourceTitle + ' [English].srt', srtContent: '1\n00:00:00,080 --> 00:00:08,880\nThe prince challenges the knight to a duel.' }, null, {
    resolveAlignments: input => { assert.equal(input.sourceTitle, spec.sourceTitle); return geminiAlign(input, null, mockFetch(matches())); },
    materializeFrames: async ({ timestamps }) => { assert.deepEqual(timestamps, [0.08]); return new Map([[0.08, 'C:/test/intro.png']]); }
  });
  assert.equal(JSON.stringify(projectData), before);
  assert.equal(result.videoClips.length, 2);
  assert.equal(result.videoClips[0].isFreeze, true);
  assert.equal(result.videoClips[0].outPoint, 6.92);
  assert.equal(result.videoClips[0].aiReason, 'title-intro-hold');
  assert.match(result.videoClips[0].label, /Оршил/);
  assert.equal(result.videoClips[1].isFreeze, false);
  assert.equal(result.videoClips[1].start, 6.92);
  assert.equal(result.videoClips[1].inPoint, 0.08);
  assert.equal(result.report.matchedCaptionCount, 1);
  assert.equal(result.report.coveredCaptionCount, 3);
  assert.equal(result.report.introCaptionCount, 2);
  assert.equal(result.report.durationError, 0);
  const saved = validateProject({ ...projectData, media: [...projectData.media, ...result.newMedia], clips: [...projectData.clips.filter(c => c.trackId !== 'v1'), ...result.videoClips] });
  assert.equal(saved.clips.find(c => c.isFreeze).aiReason, 'title-intro-hold');
});
