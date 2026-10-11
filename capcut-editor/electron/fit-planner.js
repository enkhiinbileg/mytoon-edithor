'use strict';
/**
 * Fit planner: "video follows voice".
 *
 * Given Mongolian voice slots on the timeline and the English source window
 * each slot narrates, build a gap-free V1 track using only primitives the
 * editor and exporter already support: motion clips (trim) and freeze holds.
 *
 * Voice is never compressed or cut. The video absorbs every difference:
 *   - source window longer than the slot  -> trim the tail
 *   - source window shorter than the slot -> play it fully, hold the last frame
 *   - tiny remainders (< minFreeze)       -> borrow footage from the next window
 *                                            instead of a jarring micro-freeze
 *
 * Pure function: no I/O, fully unit-tested.
 */

const EPS = 1e-6;
const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * @param {Array<{id:any, srcStart:number, srcEnd:number, voiceStart:number, voiceEnd:number}>} segments
 *   Sorted by voiceStart. srcStart/srcEnd: English source window (seconds in source video).
 *   voiceStart/voiceEnd: where the Mongolian line sits on the output timeline.
 * @param {{videoDuration:number, totalDuration:number, fps?:number, minFreeze?:number, minClip?:number}} opts
 * @returns {{clips: Array<{kind:'motion'|'freeze', segmentId:any, start:number, duration:number, inPoint?:number, outPoint?:number, freezeTs?:number}>, stats: object}}
 */
function planFit(segments, opts) {
  const videoDuration = Number(opts?.videoDuration);
  const totalDuration = Number(opts?.totalDuration);
  const fps = Number(opts?.fps) > 0 ? Number(opts.fps) : 30;
  const frame = 1 / fps;
  const minFreeze = Number.isFinite(opts?.minFreeze) ? opts.minFreeze : 0.3;
  const minClip = Number.isFinite(opts?.minClip) ? opts.minClip : frame;

  if (!(videoDuration > 0)) throw new Error('planFit: videoDuration must be > 0');
  if (!(totalDuration > 0)) throw new Error('planFit: totalDuration must be > 0');
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('planFit: no segments');

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (![s.srcStart, s.srcEnd, s.voiceStart, s.voiceEnd].every(Number.isFinite)) throw new Error(`planFit: segment ${i} has non-finite times`);
    if (s.srcEnd <= s.srcStart || s.voiceEnd <= s.voiceStart) throw new Error(`planFit: segment ${i} has empty range`);
    if (i && s.voiceStart < segments[i - 1].voiceStart - EPS) throw new Error('planFit: segments must be sorted by voiceStart');
    if (i && s.srcStart < segments[i - 1].srcStart - EPS) throw new Error('planFit: source windows must be in story order');
  }

  // Timeline slots: slot i covers [T_i, T_{i+1}); slot 0 starts at 0, last slot ends at totalDuration.
  const T = segments.map((s, i) => (i === 0 ? 0 : s.voiceStart));
  T.push(totalDuration);

  // Source windows: window i runs from its own start to the next window's start (no source gaps).
  // Window 0 is pulled back by the voice lead-in so picture and voice start together.
  const W = segments.map((s, i) => {
    const start = i === 0 ? Math.max(0, s.srcStart - s.voiceStart) : s.srcStart;
    const end = i + 1 < segments.length ? Math.max(s.srcEnd, segments[i + 1].srcStart) : Math.max(s.srcEnd, Math.min(videoDuration, s.srcEnd + 2));
    return { start: Math.min(start, videoDuration), end: Math.min(end, videoDuration) };
  });

  const clips = [];
  let t = 0;          // timeline cursor
  let cursor = 0;     // source cursor (never replay footage)
  let trimmed = 0, frozen = 0, borrowed = 0;

  const pushMotion = (segmentId, inPoint, outPoint) => {
    const d = outPoint - inPoint;
    if (d < minClip) return 0;
    const last = clips[clips.length - 1];
    // Merge with previous motion clip if source is continuous (fewer cuts, smoother export).
    if (last && last.kind === 'motion' && Math.abs(last.outPoint - inPoint) < EPS) {
      last.outPoint = r3(outPoint);
      last.duration = r3(last.outPoint - last.inPoint);
    } else {
      clips.push({ kind: 'motion', segmentId, start: r3(t), duration: r3(d), inPoint: r3(inPoint), outPoint: r3(outPoint) });
    }
    t += d;
    return d;
  };
  const pushFreeze = (segmentId, ts, d) => {
    if (d < EPS) return;
    clips.push({ kind: 'freeze', segmentId, start: r3(t), duration: r3(d), freezeTs: r3(Math.max(0, Math.min(videoDuration - frame, ts))) });
    t += d;
  };

  for (let i = 0; i < segments.length; i++) {
    const id = segments[i].id;
    const slotEnd = T[i + 1];
    const need = slotEnd - t; // measured from actual cursor so rounding never accumulates
    if (need <= EPS) continue;

    const srcFrom = Math.max(W[i].start, cursor);
    const nextStart = i + 1 < segments.length ? W[i + 1].start : videoDuration;
    const available = Math.max(0, W[i].end - srcFrom);

    if (available >= need - EPS) {
      if (available - need > frame) trimmed++;
      pushMotion(id, srcFrom, srcFrom + need);
      cursor = srcFrom + need;
    } else {
      let remainder = need - available;
      let srcTo = srcFrom + available;
      // Borrow a little from what follows instead of a micro-freeze.
      const borrowRoom = Math.max(0, Math.min(videoDuration, nextStart + minFreeze) - srcTo);
      if (remainder < minFreeze && borrowRoom >= remainder - EPS) {
        srcTo += remainder;
        remainder = 0;
        borrowed++;
      }
      pushMotion(id, srcFrom, srcTo);
      cursor = Math.max(cursor, srcTo);
      if (remainder > EPS) {
        frozen++;
        pushFreeze(id, srcTo - frame, slotEnd - t);
      }
    }
    // Snap to slot boundary (removes float drift).
    t = slotEnd;
    const last = clips[clips.length - 1];
    if (last) last.duration = r3(slotEnd - last.start);
    if (last && last.kind === 'motion') last.outPoint = r3(last.inPoint + last.duration);
  }

  validatePlan(clips, totalDuration, videoDuration);
  return {
    clips,
    stats: {
      segments: segments.length, clips: clips.length,
      motion: clips.filter((c) => c.kind === 'motion').length,
      freeze: clips.filter((c) => c.kind === 'freeze').length,
      frozenSeconds: r3(clips.filter((c) => c.kind === 'freeze').reduce((a, c) => a + c.duration, 0)),
      trimmed, frozen, borrowed
    }
  };
}

/** Throws if the plan has gaps, overlaps, bad durations or out-of-range source. */
function validatePlan(clips, totalDuration, videoDuration) {
  let t = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (Math.abs(c.start - t) > 0.0015) throw new Error(`validatePlan: gap/overlap at clip ${i} (start ${c.start}, expected ${r3(t)})`);
    if (!(c.duration > 0)) throw new Error(`validatePlan: clip ${i} has non-positive duration`);
    if (c.kind === 'motion') {
      if (c.inPoint < -EPS || c.outPoint > videoDuration + 0.0015 || c.outPoint <= c.inPoint) throw new Error(`validatePlan: clip ${i} source out of range`);
      if (Math.abs((c.outPoint - c.inPoint) - c.duration) > 0.0015) throw new Error(`validatePlan: clip ${i} duration mismatch`);
    }
    t = c.start + c.duration;
  }
  if (Math.abs(t - totalDuration) > 0.0015) throw new Error(`validatePlan: plan ends at ${r3(t)}, expected ${r3(totalDuration)}`);
  return true;
}

module.exports = { planFit, validatePlan };
