'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { chunkTranscript, toSrtTimestamp } = require('../electron/recap-dub-pipeline');
const { planFit, validatePlan } = require('../electron/fit-planner');
const { validateProject } = require('../electron/project-store');

test('Pipeline end-to-end dry run: transcript -> chunk -> fit -> project schema', () => {
  // 1. Mock raw transcript segments (simulating Whisper large-v3 output)
  const rawSegments = [
    { start: 0.0, end: 1.8, text: 'The story begins in an ancient kingdom' },
    { start: 1.8, end: 3.5, text: 'where warriors fought for glory.' },
    { start: 4.0, end: 6.2, text: 'Suddenly, a dark omen appeared in the sky.' },
    { start: 7.0, end: 9.5, text: 'No one knew how to survive the storm.' }
  ];

  // 2. Chunking
  const chunks = chunkTranscript(rawSegments, 7.5, 2.5);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].srcStart, 0);
  assert.equal(chunks[0].srcEnd, 3.5);

  // 3. Simulated Mongolian translations
  const mongolianLines = [
    'Эртний хаант улсад дайчид алдар нэрийн төлөө тулалдаж байх үеэс түүх эхэлнэ.',
    'Гэнэт тэнгэрт аймшигт бараан дохио тодрон үзэгдэж, хэн ч энэ шуургыг даван туулахаа мэдэхгүй байлаа.'
  ];

  for (let i = 0; i < chunks.length; i++) {
    chunks[i].mongolianText = mongolianLines[i];
    chunks[i].voiceDuration = 4.2; // Spoken length in seconds
  }

  // 4. Voice timing layout
  let cursor = 0.1;
  const speechGap = 0.15;
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].voiceStart = Math.round(cursor * 1000) / 1000;
    chunks[i].voiceEnd = Math.round((cursor + chunks[i].voiceDuration) * 1000) / 1000;
    cursor = chunks[i].voiceEnd + speechGap;
  }
  const totalTimelineDuration = Math.round((cursor + 0.2) * 1000) / 1000;

  // 5. Fit planning
  const plannerSegments = chunks.map((c) => ({
    id: c.id,
    srcStart: c.srcStart,
    srcEnd: c.srcEnd,
    voiceStart: c.voiceStart,
    voiceEnd: c.voiceEnd
  }));

  const videoDuration = 10.0;
  const fitResult = planFit(plannerSegments, {
    videoDuration,
    totalDuration: totalTimelineDuration,
    fps: 30
  });

  assert.ok(fitResult.clips.length >= chunks.length);
  validatePlan(fitResult.clips, totalTimelineDuration, videoDuration);

  // 6. Build Cutline project document
  const mediaList = [
    {
      id: 'source_video',
      path: 'C:\\fake\\video.mp4',
      name: 'video.mp4',
      kind: 'video',
      duration: videoDuration,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      thumbs: []
    }
  ];

  for (let i = 0; i < chunks.length; i++) {
    mediaList.push({
      id: `voice_${chunks[i].id}`,
      path: `C:\\fake\\voice_${i}.mp3`,
      name: `Voice ${i}`,
      kind: 'audio',
      duration: chunks[i].voiceDuration,
      width: 0,
      height: 0,
      fps: 30,
      hasAudio: true,
      thumbs: []
    });
  }

  const tracksList = [
    { id: 'v1', kind: 'video', name: 'Video', hidden: false, muted: false, locked: false },
    { id: 'a1', kind: 'audio', name: 'Voice', hidden: false, muted: false, locked: false },
    { id: 'ov1', kind: 'overlay', name: 'Subtitles', hidden: false, muted: false, locked: false }
  ];

  const projectClips = [];
  for (let i = 0; i < fitResult.clips.length; i++) {
    const pc = fitResult.clips[i];
    if (pc.kind === 'motion') {
      projectClips.push({
        id: `vclip_${i}`,
        kind: 'av',
        trackId: 'v1',
        mediaId: 'source_video',
        start: pc.start,
        inPoint: pc.inPoint,
        outPoint: pc.outPoint,
        volume: 0,
        opacity: 1
      });
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    projectClips.push({
      id: `aclip_${i}`,
      kind: 'av',
      trackId: 'a1',
      mediaId: `voice_${c.id}`,
      start: c.voiceStart,
      inPoint: 0,
      outPoint: c.voiceDuration,
      volume: 1,
      opacity: 1
    });

    projectClips.push({
      id: `sclip_${i}`,
      kind: 'text',
      trackId: 'ov1',
      start: c.voiceStart,
      inPoint: 0,
      outPoint: c.voiceDuration,
      x: 0.5,
      y: 0.83,
      opacity: 1,
      style: {
        text: c.mongolianText,
        color: '#FFFFFF',
        background: '',
        fontSize: 36,
        bold: true,
        shadow: true
      }
    });
  }

  const projectDoc = {
    format: 'cutline-project',
    version: 1,
    name: 'Test Project',
    settings: { width: 1920, height: 1080, fps: 30 },
    media: mediaList,
    tracks: tracksList,
    clips: projectClips
  };

  // Validate that the project matches Cutline schema
  const validated = validateProject(projectDoc);
  assert.equal(validated.format, 'cutline-project');
  assert.equal(validated.clips.length, projectClips.length);
  assert.equal(validated.tracks.length, 3);
});
