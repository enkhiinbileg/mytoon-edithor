'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { planFit, validatePlan } = require('../electron/fit-planner');

const seg = (id, srcStart, srcEnd, voiceStart, voiceEnd) => ({ id, srcStart, srcEnd, voiceStart, voiceEnd });
const end = (clips) => { const c = clips[clips.length - 1]; return Math.round((c.start + c.duration) * 1000) / 1000; };

test('equal lengths -> single continuous motion clip, no freeze', () => {
  const segs = [seg(1, 0, 5, 0, 5), seg(2, 5, 10, 5, 10)];
  const { clips, stats } = planFit(segs, { videoDuration: 20, totalDuration: 10 });
  assert.strictEqual(stats.freeze, 0);
  assert.strictEqual(clips.length, 1);
  assert.deepStrictEqual([clips[0].inPoint, clips[0].outPoint], [0, 10]);
});

test('voice longer than source -> full source then freeze hold', () => {
  const segs = [seg(1, 0, 4, 0, 7), seg(2, 4, 8, 7, 11)];
  const { clips } = planFit(segs, { videoDuration: 20, totalDuration: 11 });
  assert.strictEqual(clips[0].kind, 'motion');
  assert.deepStrictEqual([clips[0].inPoint, clips[0].outPoint], [0, 4]);
  assert.strictEqual(clips[1].kind, 'freeze');
  assert.strictEqual(clips[1].duration, 3);
  assert.strictEqual(clips[2].inPoint, 4); // next segment resumes exactly where story continues
  assert.strictEqual(end(clips), 11);
});

test('voice shorter than source -> tail trimmed, next segment starts at its own source', () => {
  const segs = [seg(1, 0, 8, 0, 5), seg(2, 8, 12, 5, 9)];
  const { clips, stats } = planFit(segs, { videoDuration: 20, totalDuration: 9 });
  assert.strictEqual(stats.freeze, 0);
  assert.deepStrictEqual([clips[0].inPoint, clips[0].outPoint], [0, 5]);
  assert.strictEqual(clips[1].inPoint, 8);
  assert.strictEqual(end(clips), 9);
});

test('tiny remainder borrows footage instead of a micro-freeze', () => {
  const segs = [seg(1, 0, 5, 0, 5.2), seg(2, 5, 10, 5.2, 10.2)];
  const { stats } = planFit(segs, { videoDuration: 20, totalDuration: 10.2 });
  assert.strictEqual(stats.freeze, 0);
  assert.strictEqual(stats.borrowed, 1);
});

test('lead-in silence: picture starts earlier so voice and picture align', () => {
  const segs = [seg(1, 3, 6, 1, 4)];
  const { clips } = planFit(segs, { videoDuration: 20, totalDuration: 4 });
  assert.strictEqual(clips[0].inPoint, 2);
  assert.strictEqual(end(clips), 4);
});

test('never exceeds source video length; freezes at the end instead', () => {
  const segs = [seg(1, 0, 9, 0, 15)];
  const { clips } = planFit(segs, { videoDuration: 10, totalDuration: 15 });
  for (const c of clips) if (c.kind === 'motion') assert.ok(c.outPoint <= 10);
  assert.strictEqual(end(clips), 15);
});

test('randomised: always gap-free, exact total, source in range, story order kept', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let run = 0; run < 300; run++) {
    const n = 1 + Math.floor(rnd() * 40);
    const segs = [];
    let src = rnd() * 3, voice = rnd() * 2;
    for (let i = 0; i < n; i++) {
      const sLen = 0.5 + rnd() * 8, vLen = 0.5 + rnd() * 10;
      segs.push(seg(i, src, src + sLen, voice, voice + vLen));
      src += sLen + rnd() * 2;
      voice += vLen + rnd() * 0.6;
    }
    const videoDuration = src + rnd() * 5;
    const totalDuration = voice + 0.3;
    const { clips } = planFit(segs, { videoDuration, totalDuration });
    assert.ok(validatePlan(clips, totalDuration, videoDuration));
    let lastIn = -1;
    for (const c of clips) if (c.kind === 'motion') { assert.ok(c.inPoint >= lastIn - 1e-6, 'story order'); lastIn = c.inPoint; }
  }
});

test('rejects bad input', () => {
  assert.throws(() => planFit([], { videoDuration: 1, totalDuration: 1 }));
  assert.throws(() => planFit([seg(1, 5, 4, 0, 1)], { videoDuration: 10, totalDuration: 1 }));
  assert.throws(() => planFit([seg(1, 5, 6, 2, 3), seg(2, 1, 2, 3, 4)], { videoDuration: 10, totalDuration: 4 }));
});
