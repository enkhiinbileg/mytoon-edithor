import type { Clip, OverlayImage } from './types';
import { clipEnd } from './types';

/** Overlay sizes are authored against a 1080p canvas and scaled at render time. */
export const REF_H = 1080;

export const OVERLAY_FONT =
  '"Segoe UI Emoji", "Segoe UI", system-ui, -apple-system, sans-serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Draw a text or sticker clip to a transparent PNG.
 * `scale` maps authored (1080p) sizes onto the export canvas.
 */
function wrapText(text: string, maxCharsPerLine = 34): string[] {
  const rawLines = text.split('\n');
  const result: string[] = [];
  for (const rawLine of rawLines) {
    if (rawLine.length <= maxCharsPerLine) {
      result.push(rawLine);
      continue;
    }
    const words = rawLine.split(/\s+/);
    let curLine = '';
    for (const w of words) {
      if (!curLine) {
        curLine = w;
      } else if ((curLine.length + 1 + w.length) <= maxCharsPerLine) {
        curLine += ' ' + w;
      } else {
        result.push(curLine);
        curLine = w;
      }
    }
    if (curLine) result.push(curLine);
  }
  return result.length > 0 ? result : [text];
}

export function rasterizeOverlay(clip: Clip, scale: number, encode = true): { dataUrl: string; w: number; h: number; canvas: HTMLCanvasElement } | null {
  const st = clip.style;
  if (!st || !st.text) return null;

  const fontSize = Math.max(4, st.fontSize * scale);
  const fontFamily = st.fontFamily ? `"${st.fontFamily}", ${OVERLAY_FONT}` : OVERLAY_FONT;
  const font = `${st.bold ? '800' : '500'} ${fontSize}px ${fontFamily}`;

  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;
  probe.font = font;

  // Auto-wrap lines so captions fit beautifully like CapCut
  const lines = wrapText(st.text, 34);

  const m = probe.measureText('Mg');
  const textW = Math.max(1, ...lines.map(line => probe.measureText(line).width));
  const ascent = m.actualBoundingBoxAscent || fontSize * 0.8;
  const descent = m.actualBoundingBoxDescent || fontSize * 0.25;

  const hasStroke = st.stroke !== false && (Boolean(st.stroke) || Boolean(st.strokeWidth) || !st.background);
  const strokeW = hasStroke ? Math.max(2, (st.strokeWidth || 5) * scale) : 0;

  const pad = st.background ? fontSize * 0.24 : 0;
  const blur = st.shadow ? fontSize * 0.16 : 0;
  const extraMargin = strokeW * 2;

  // ffmpeg's overlay filter needs even dimensions for some pixel formats.
  const w = Math.ceil((textW + pad * 2 + blur * 2 + extraMargin) / 2) * 2;
  const lineHeight = fontSize * 1.18;
  const h = Math.ceil((ascent + descent + (lines.length - 1) * lineHeight + pad * 2 + blur * 2 + extraMargin) / 2) * 2;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Resizing the canvas resets context state, so styles are set afterwards.
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';

  if (st.background) {
    ctx.fillStyle = st.background;
    roundRect(ctx, blur + strokeW, blur + strokeW, w - (blur + strokeW) * 2, h - (blur + strokeW) * 2, fontSize * 0.2);
    ctx.fill();
  }

  if (st.shadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = blur * 2;
    ctx.shadowOffsetY = fontSize * 0.06;
  }

  ctx.textAlign = 'center';
  const baseY = blur + pad + strokeW + ascent;

  // Draw CapCut signature stroke / outline
  if (hasStroke) {
    ctx.strokeStyle = st.strokeColor || '#000000';
    ctx.lineWidth = strokeW;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    lines.forEach((line, i) => {
      ctx.strokeText(line, w / 2, baseY + i * lineHeight);
    });
  }

  // Draw text fill
  ctx.fillStyle = st.color || '#FFFFFF';
  lines.forEach((line, i) => {
    ctx.fillText(line, w / 2, baseY + i * lineHeight);
  });

  return { dataUrl: encode ? canvas.toDataURL('image/png') : '', w, h, canvas };
}

export interface OverlayPreparation {
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}

/** Async PNG encoding lets the window paint and respond to Cancel between captions. */
async function encodeCanvas(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    value => value ? resolve(value) : reject(new Error('Cannot encode caption image.')), 'image/png'));
  signal?.throwIfAborted();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Cannot read caption image.'));
    reader.readAsDataURL(blob);
  });
  signal?.throwIfAborted();
  return dataUrl;
}

/** Compose caption changes into one nonoverlapping transparent image sequence.
 * This preserves the renderer's font, wrapping, shadows and stacking, while
 * avoiding thousands of simultaneous image inputs in the export process.
 */
async function buildCompositeOverlays(clips: Clip[], outW: number, outH: number, preparation: OverlayPreparation): Promise<OverlayImage[]> {
  const events = new Map<number, { starts: number[]; ends: number[] }>();
  const add = (time: number, kind: 'starts' | 'ends', index: number) => {
    const event = events.get(time) ?? { starts: [], ends: [] };
    event[kind].push(index);
    events.set(time, event);
  };
  clips.forEach((clip, index) => {
    const start = Math.max(0, clip.start), end = clipEnd(clip);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    add(start, 'starts', index);
    add(end, 'ends', index);
  });
  const times = [...events.keys()].sort((a, b) => a - b);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Cannot prepare caption images for export.');
  const active = new Map<number, NonNullable<ReturnType<typeof rasterizeOverlay>>>();
  const output: OverlayImage[] = [];
  let completed = 0;
  for (let index = 0; index + 1 < times.length; index += 1) {
    preparation.signal?.throwIfAborted();
    const time = times[index], event = events.get(time)!;
    for (const clipIndex of event.ends) active.delete(clipIndex);
    for (const clipIndex of event.starts) {
      const image = rasterizeOverlay(clips[clipIndex], outH / REF_H, false);
      if (image) active.set(clipIndex, image);
      completed++;
    }
    if (!active.size) continue;
    context.clearRect(0, 0, outW, outH);
    // Keep the original overlay stacking order when captions/stickers overlap.
    for (const clipIndex of [...active.keys()].sort((a, b) => a - b)) {
      const clip = clips[clipIndex], image = active.get(clipIndex)!;
      context.globalAlpha = clip.opacity ?? 1;
      context.drawImage(image.canvas,
        Math.round((clip.x ?? 0.5) * outW - image.w / 2),
        Math.round((clip.y ?? 0.5) * outH - image.h / 2));
    }
    context.globalAlpha = 1;
    output.push({ dataUrl: await encodeCanvas(canvas, preparation.signal), start: time, end: times[index + 1],
      x: 0, y: 0, w: outW, h: outH, opacity: 1 });
    preparation.onProgress?.(completed, clips.length);
  }
  return output;
}

/** Turn every overlay clip into a positioned image for the export pipeline. */
export async function buildOverlays(clips: Clip[], outW: number, outH: number, preparation: OverlayPreparation = {}): Promise<OverlayImage[]> {
  const overlayClips = clips.filter((clip) => (clip.kind === 'text' || clip.kind === 'sticker') && clip.style?.text);
  preparation.onProgress?.(0, overlayClips.length);
  // Paint the initial preparation state before measuring/rasterizing any text.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  preparation.signal?.throwIfAborted();
  if (overlayClips.length > 32) return buildCompositeOverlays(overlayClips, outW, outH, preparation);
  const scale = outH / REF_H;
  const out: OverlayImage[] = [];

  for (const c of overlayClips) {
    preparation.signal?.throwIfAborted();
    const img = rasterizeOverlay(c, scale, false);
    if (!img) continue;

    const cx = (c.x ?? 0.5) * outW;
    const cy = (c.y ?? 0.5) * outH;
    out.push({
      dataUrl: await encodeCanvas(img.canvas, preparation.signal),
      start: c.start,
      end: clipEnd(c),
      x: Math.round(cx - img.w / 2),
      y: Math.round(cy - img.h / 2),
      w: img.w,
      h: img.h,
      opacity: c.opacity ?? 1
    });
    preparation.onProgress?.(out.length, overlayClips.length);
  }
  return out;
}
