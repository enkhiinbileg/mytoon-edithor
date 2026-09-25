import type { Clip, Keyframe } from './types';

const uid = () => Math.random().toString(36).slice(2, 10);

/** Linear interpolation helper */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Smooth cubic ease-in-out interpolation for cinematic CapCut-style camera movement */
const easeInOut = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export interface TransformValues {
  scale: number;
  x: number;
  y: number;
  rotation: number;
  opacity: number;
}

/**
 * Calculates the interpolated transform values for a clip at the current playhead time.
 * If keyframes exist, smoothly interpolates between them; otherwise returns base clip values.
 */
export function interpolateClipKeyframes(clip: Clip, playhead: number): TransformValues {
  const baseScale = clip.scale ?? 1;
  const baseX = clip.x ?? 0.5;
  const baseY = clip.y ?? 0.5;
  const baseRotation = clip.rotation ?? 0;
  const baseOpacity = clip.opacity ?? 1;

  if (!clip.keyframes || clip.keyframes.length === 0) {
    return {
      scale: baseScale,
      x: baseX,
      y: baseY,
      rotation: baseRotation,
      opacity: baseOpacity
    };
  }

  const duration = clip.outPoint - clip.inPoint;
  const relTime = Math.max(0, Math.min(duration, playhead - clip.start));

  const sorted = [...clip.keyframes].sort((a, b) => a.time - b.time);

  // Before first keyframe
  if (relTime <= sorted[0].time) {
    const kf = sorted[0];
    return {
      scale: kf.scale ?? baseScale,
      x: kf.x ?? baseX,
      y: kf.y ?? baseY,
      rotation: kf.rotation ?? baseRotation,
      opacity: kf.opacity ?? baseOpacity
    };
  }

  // After last keyframe
  if (relTime >= sorted[sorted.length - 1].time) {
    const kf = sorted[sorted.length - 1];
    return {
      scale: kf.scale ?? baseScale,
      x: kf.x ?? baseX,
      y: kf.y ?? baseY,
      rotation: kf.rotation ?? baseRotation,
      opacity: kf.opacity ?? baseOpacity
    };
  }

  // Between two keyframes
  for (let i = 0; i < sorted.length - 1; i++) {
    const kf1 = sorted[i];
    const kf2 = sorted[i + 1];

    if (relTime >= kf1.time && relTime <= kf2.time) {
      const span = kf2.time - kf1.time;
      const rawT = span > 0 ? (relTime - kf1.time) / span : 0;
      const t = easeInOut(rawT);

      const s1 = kf1.scale ?? baseScale;
      const s2 = kf2.scale ?? baseScale;

      const x1 = kf1.x ?? baseX;
      const x2 = kf2.x ?? baseX;

      const y1 = kf1.y ?? baseY;
      const y2 = kf2.y ?? baseY;

      const r1 = kf1.rotation ?? baseRotation;
      const r2 = kf2.rotation ?? baseRotation;

      const o1 = kf1.opacity ?? baseOpacity;
      const o2 = kf2.opacity ?? baseOpacity;

      return {
        scale: lerp(s1, s2, t),
        x: lerp(x1, x2, t),
        y: lerp(y1, y2, t),
        rotation: lerp(r1, r2, t),
        opacity: lerp(o1, o2, t)
      };
    }
  }

  return {
    scale: baseScale,
    x: baseX,
    y: baseY,
    rotation: baseRotation,
    opacity: baseOpacity
  };
}

/**
 * Returns keyframe within tolerance seconds of the playhead.
 */
export function getKeyframeAt(clip: Clip, playhead: number, tolerance = 0.08): Keyframe | undefined {
  if (!clip.keyframes || clip.keyframes.length === 0) return undefined;
  const relTime = playhead - clip.start;
  return clip.keyframes.find((kf) => Math.abs(kf.time - relTime) <= tolerance);
}

/**
 * Returns the nearest preceding and next keyframes relative to the playhead.
 */
export function getPrevNextKeyframes(
  clip: Clip,
  playhead: number
): { prev?: Keyframe; next?: Keyframe } {
  if (!clip.keyframes || clip.keyframes.length === 0) return {};
  const relTime = playhead - clip.start;
  const sorted = [...clip.keyframes].sort((a, b) => a.time - b.time);

  let prev: Keyframe | undefined;
  let next: Keyframe | undefined;

  for (const kf of sorted) {
    if (kf.time < relTime - 0.05) {
      prev = kf;
    } else if (kf.time > relTime + 0.05 && !next) {
      next = kf;
    }
  }

  return { prev, next };
}

/**
 * Adds a new keyframe or updates an existing one at the given playhead time.
 */
export function addOrUpdateKeyframe(
  clip: Clip,
  playhead: number,
  values: Partial<Omit<Keyframe, 'id' | 'time'>>
): Keyframe[] {
  const duration = clip.outPoint - clip.inPoint;
  const relTime = Math.max(0, Math.min(duration, Math.round((playhead - clip.start) * 100) / 100));

  const existing = clip.keyframes || [];
  const idx = existing.findIndex((kf) => Math.abs(kf.time - relTime) <= 0.06);

  if (idx >= 0) {
    // Update existing keyframe
    const updated = [...existing];
    updated[idx] = {
      ...updated[idx],
      ...values,
      time: relTime
    };
    return updated.sort((a, b) => a.time - b.time);
  }

  // Add new keyframe with current interpolated values merged
  const current = interpolateClipKeyframes(clip, playhead);
  const newKf: Keyframe = {
    id: uid(),
    time: relTime,
    scale: values.scale ?? current.scale,
    x: values.x ?? current.x,
    y: values.y ?? current.y,
    rotation: values.rotation ?? current.rotation,
    opacity: values.opacity ?? current.opacity
  };

  return [...existing, newKf].sort((a, b) => a.time - b.time);
}

/**
 * Removes a keyframe by its ID.
 */
export function removeKeyframe(clip: Clip, keyframeId: string): Keyframe[] {
  if (!clip.keyframes) return [];
  return clip.keyframes.filter((kf) => kf.id !== keyframeId);
}
