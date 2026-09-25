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

export function rasterizeOverlay(clip: Clip, scale: number): { dataUrl: string; w: number; h: number } | null {
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

  return { dataUrl: canvas.toDataURL('image/png'), w, h };
}

/** Turn every overlay clip into a positioned image for the export pipeline. */
export function buildOverlays(clips: Clip[], outW: number, outH: number): OverlayImage[] {
  const scale = outH / REF_H;
  const out: OverlayImage[] = [];

  for (const c of clips) {
    if (c.kind !== 'text' && c.kind !== 'sticker') continue;
    const img = rasterizeOverlay(c, scale);
    if (!img) continue;

    const cx = (c.x ?? 0.5) * outW;
    const cy = (c.y ?? 0.5) * outH;
    out.push({
      dataUrl: img.dataUrl,
      start: c.start,
      end: clipEnd(c),
      x: Math.round(cx - img.w / 2),
      y: Math.round(cy - img.h / 2),
      w: img.w,
      h: img.h,
      opacity: c.opacity ?? 1
    });
  }
  return out;
}
