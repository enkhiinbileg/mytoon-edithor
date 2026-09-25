/** 12.34 -> "00:00:12.34" (CapCut-style readout) */
export function formatTime(seconds: number, withCentis = true): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return withCentis ? `${base}.${String(cs).padStart(2, '0')}` : base;
}

/** Short duration badge: "1:05" */
export function formatShort(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Pick a ruler tick spacing that keeps labels ~70-120px apart. */
export function tickStep(pxPerSecond: number): number {
  const candidates = [
    0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200,
    10800, 14400, 21600, 28800, 43200, 86400
  ];
  for (const c of candidates) {
    if (c * pxPerSecond >= 70) return c;
  }
  return Math.max(3600, Math.ceil(70 / Math.max(0.00001, pxPerSecond) / 600) * 600);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
