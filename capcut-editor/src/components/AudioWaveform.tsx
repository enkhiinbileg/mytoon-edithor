import React, { memo, useEffect, useRef, useState } from 'react';
import type { Clip, MediaItem } from '../types';
import { getCachedWaveform, requestWaveform, subscribeWaveform } from '../utils/waveformService';

interface AudioWaveformProps {
  clip: Clip;
  media?: MediaItem;
  width: number;
  height: number;
  zoom: number;
  viewport: { left: number; right: number };
  clipLeft: number;
}

export const AudioWaveform = memo(function AudioWaveform({
  clip,
  media,
  width,
  height,
  zoom,
  viewport,
  clipLeft
}: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaPath = media?.path;
  const [waveData, setWaveData] = useState(() => (mediaPath ? getCachedWaveform(mediaPath) : null));

  // Request waveform data and subscribe to async completion
  useEffect(() => {
    if (!mediaPath) return;

    const cached = getCachedWaveform(mediaPath);
    if (cached) {
      setWaveData(cached);
      return;
    }

    let active = true;
    requestWaveform(mediaPath).then((data) => {
      if (active && data) {
        setWaveData(data);
      }
    });

    const unsubscribe = subscribeWaveform((path, data) => {
      if (active && path === mediaPath) {
        setWaveData(data);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [mediaPath]);

  // Windowed visible slice within viewport (with 150px overscan)
  const viewLeft = Math.max(0, viewport.left - 150);
  const viewRight = viewport.right + 150;
  const clipRight = clipLeft + width;

  const isVisible = clipRight >= viewLeft && clipLeft <= viewRight;
  const visibleStart = Math.max(0, viewLeft - clipLeft);
  const visibleEnd = Math.min(width, viewRight - clipLeft);
  const visibleWidth = Math.max(1, Math.ceil(visibleEnd - visibleStart));

  // Draw waveform on canvas
  useEffect(() => {
    if (!isVisible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const canvasW = Math.max(1, Math.round(visibleWidth * dpr));
    const canvasH = Math.max(1, Math.round(height * dpr));

    if (canvas.width !== canvasW || canvas.height !== canvasH) {
      canvas.width = canvasW;
      canvas.height = canvasH;
    }

    ctx.clearRect(0, 0, canvasW, canvasH);

    const baselineY = Math.round((height - 3) * dpr);
    const maxBarH = Math.max(4, Math.round((height - 12) * dpr));
    const minBarH = Math.max(1, Math.round(1.5 * dpr));

    // Subtle baseline guide line along bottom
    ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
    ctx.fillRect(0, baselineY, canvasW, Math.max(1, Math.round(1 * dpr)));

    if (!waveData || !waveData.peaks || waveData.peaks.length === 0) {
      // Smooth loading wave envelope
      ctx.beginPath();
      ctx.moveTo(0, baselineY);
      for (let x = 0; x <= canvasW; x += 4 * dpr) {
        const ph = Math.sin(x * 0.04) * 0.5 + 0.5;
        const h = Math.max(2 * dpr, ph * maxBarH * 0.35);
        ctx.lineTo(x, baselineY - h);
      }
      ctx.lineTo(canvasW, baselineY);
      ctx.closePath();
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.fill();
      return;
    }

    const { peaks, pointsPerSecond } = waveData;
    const peakCount = peaks.length;
    const inPoint = clip.inPoint ?? 0;
    const volume = typeof clip.volume === 'number' ? Math.max(0, Math.min(2, clip.volume)) : 1.0;

    // 1. Sample peak amplitude across visible pixel columns
    const step = 1 * dpr; // 1 device pixel resolution
    const numPoints = Math.ceil(canvasW / step);
    const rawY: number[] = new Array(numPoints + 1);

    for (let i = 0; i <= numPoints; i++) {
      const px = Math.min(canvasW, i * step);
      const pixelInClip = visibleStart + px / dpr;
      const t1 = inPoint + pixelInClip / zoom;
      const t2 = inPoint + (pixelInClip + step / dpr) / zoom;

      const idx1 = Math.max(0, Math.floor(t1 * pointsPerSecond));
      const idx2 = Math.min(peakCount - 1, Math.ceil(t2 * pointsPerSecond));

      let maxPeak = 0;
      if (idx1 <= idx2) {
        for (let idx = idx1; idx <= idx2; idx++) {
          const val = peaks[idx];
          if (val > maxPeak) maxPeak = val;
        }
      } else if (idx1 < peakCount) {
        maxPeak = peaks[idx1];
      }

      let barH = 0;
      if (maxPeak > 0) {
        const scaledVal = maxPeak * volume;
        const norm = Math.min(1, scaledVal / 100);
        if (norm > 0) {
          // Dynamic range curve matching CapCut: ensures quiet speech/consonants
          // are visibly distinct, while true silence remains completely flat on baseline
          const powerScaled = Math.pow(norm, 0.78);
          barH = Math.max(minBarH, powerScaled * maxBarH);
        }
      }

      rawY[i] = baselineY - barH;
    }

    // 3. Smooth curve using 3-tap moving average for silky rolling envelope
    const smoothY: number[] = new Array(numPoints + 1);
    for (let i = 0; i <= numPoints; i++) {
      const prev = rawY[Math.max(0, i - 1)];
      const curr = rawY[i];
      const next = rawY[Math.min(numPoints, i + 1)];
      smoothY[i] = prev * 0.25 + curr * 0.5 + next * 0.25;
    }

    // 4. Fill continuous solid waveform polygon
    ctx.beginPath();
    ctx.moveTo(0, baselineY);
    ctx.lineTo(0, smoothY[0]);

    for (let i = 1; i <= numPoints; i++) {
      const prevX = (i - 1) * step;
      const currX = Math.min(canvasW, i * step);
      const midX = (prevX + currX) / 2;
      const midY = (smoothY[i - 1] + smoothY[i]) / 2;
      ctx.quadraticCurveTo(prevX, smoothY[i - 1], midX, midY);
    }
    ctx.lineTo(canvasW, smoothY[numPoints]);
    ctx.lineTo(canvasW, baselineY);
    ctx.closePath();

    // CapCut sky-blue vertical gradient
    const fillGradient = ctx.createLinearGradient(0, baselineY, 0, baselineY - maxBarH);
    fillGradient.addColorStop(0, '#0284c7');      // deep sky-blue base
    fillGradient.addColorStop(0.4, '#0ea5e9');    // rich vibrant blue
    fillGradient.addColorStop(0.8, '#38bdf8');    // bright cyan
    fillGradient.addColorStop(1.0, '#7dd3fc');    // luminous highlight at peak

    ctx.fillStyle = fillGradient;
    ctx.fill();

    // 5. Crisp luminous stroke along the top edge of the waveform
    ctx.beginPath();
    ctx.moveTo(0, smoothY[0]);
    for (let i = 1; i <= numPoints; i++) {
      const prevX = (i - 1) * step;
      const currX = Math.min(canvasW, i * step);
      const midX = (prevX + currX) / 2;
      const midY = (smoothY[i - 1] + smoothY[i]) / 2;
      ctx.quadraticCurveTo(prevX, smoothY[i - 1], midX, midY);
    }
    ctx.lineTo(canvasW, smoothY[numPoints]);
    ctx.strokeStyle = '#7dd3fc';
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();

    // 6. Subtle 0 dB Volume Reference Line (CapCut horizontal reference across hills & silent gaps)
    const volumeLineY = Math.round(baselineY - maxBarH * 0.45);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, volumeLineY);
    ctx.lineTo(canvasW, volumeLineY);
    ctx.stroke();

    // 7. Bottom baseline line
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, baselineY);
    ctx.lineTo(canvasW, baselineY);
    ctx.stroke();
  }, [waveData, isVisible, visibleWidth, height, zoom, visibleStart, clip.inPoint, clip.volume]);

  if (!isVisible) return null;

  return (
    <div
      className="clip-waveform-container"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none'
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          left: visibleStart,
          top: 0,
          width: visibleWidth,
          height: height,
          pointerEvents: 'none'
        }}
      />
    </div>
  );
});
export default AudioWaveform;
