/**
 * Single source of truth for the visual "looks" a clip can carry.
 *
 * Every entry defines the same look twice: `css` drives the live preview and
 * `ff` (an ffmpeg filter chain) drives the render. Keeping them side by side is
 * what stops the exported file drifting away from what the user previewed.
 */

export interface Filter {
  id: string;
  label: string;
  css: string;
  /** ffmpeg video filter chain, or '' for a no-op. */
  ff: string;
}

export const FILTERS: Filter[] = [
  { id: 'none', label: 'None', css: '', ff: '' },
  {
    id: 'warm',
    label: 'Warm',
    css: 'saturate(1.15) sepia(0.18) hue-rotate(-8deg)',
    ff: 'eq=saturation=1.15,colorbalance=rs=0.12:gs=0.02:bs=-0.10'
  },
  {
    id: 'cool',
    label: 'Cool',
    css: 'saturate(1.05) hue-rotate(12deg) brightness(1.02)',
    ff: 'colorbalance=rs=-0.10:bs=0.14,eq=brightness=0.02'
  },
  {
    id: 'mono',
    label: 'Mono',
    css: 'grayscale(1) contrast(1.08)',
    ff: 'hue=s=0,eq=contrast=1.08'
  },
  {
    id: 'vivid',
    label: 'Vivid',
    css: 'saturate(1.5) contrast(1.12)',
    ff: 'eq=saturation=1.5:contrast=1.12'
  },
  {
    id: 'vintage',
    label: 'Vintage',
    css: 'sepia(0.45) saturate(0.85) contrast(0.95) brightness(1.05)',
    ff: 'curves=preset=vintage'
  },
  {
    id: 'cinematic',
    label: 'Cinematic',
    css: 'contrast(1.15) saturate(0.9) brightness(0.98)',
    ff: 'eq=contrast=1.15:saturation=0.9:brightness=-0.02,colorbalance=rs=-0.05:bs=0.08'
  },
  {
    id: 'fade',
    label: 'Faded',
    css: 'contrast(0.88) saturate(0.8) brightness(1.08)',
    ff: 'eq=contrast=0.88:saturation=0.8:brightness=0.06'
  }
];

export interface Effect {
  id: string;
  label: string;
  /** CSS animation shorthand applied to the preview surface. */
  css: string;
  /**
   * Build the ffmpeg chain. `d` is the clip duration in seconds and `w`/`h`/`fps`
   * the project canvas, because several effects need explicit geometry.
   */
  ff(d: number, w: number, h: number, fps: number): string;
}

export const EFFECTS: Effect[] = [
  { id: 'none', label: 'None', css: '', ff: () => '' },
  {
    id: 'zoomIn',
    label: 'Zoom in',
    css: 'cc-zoom-in var(--cc-dur) linear both',
    ff: (d, w, h, fps) =>
      `zoompan=z='min(1+0.25*on/(${Math.max(1, Math.round(d * fps))}),1.25)':` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}`
  },
  {
    id: 'zoomOut',
    label: 'Zoom out',
    css: 'cc-zoom-out var(--cc-dur) linear both',
    ff: (d, w, h, fps) =>
      `zoompan=z='max(1.25-0.25*on/(${Math.max(1, Math.round(d * fps))}),1)':` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}`
  },
  {
    id: 'shake',
    label: 'Shake',
    css: 'cc-shake 0.5s linear infinite',
    // Crop a slightly inset window and jitter it, then restore the canvas size.
    ff: (_d, w, h) =>
      `crop=iw-24:ih-24:x='12+6*sin(2*PI*t*6)':y='12+6*cos(2*PI*t*7)',scale=${w}:${h}`
  },
  {
    id: 'pulse',
    label: 'Pulse',
    css: 'cc-pulse 1.2s ease-in-out infinite',
    ff: () => `eq=brightness='0.07*sin(2*PI*t*1.6)':eval=frame`
  },
  {
    id: 'fadeIn',
    label: 'Fade in',
    css: 'cc-fade-in 0.6s ease-out both',
    ff: () => 'fade=t=in:st=0:d=0.6'
  },
  {
    id: 'fadeOut',
    label: 'Fade out',
    css: 'cc-fade-out 0.6s ease-in both',
    ff: (d) => `fade=t=out:st=${Math.max(0, d - 0.6).toFixed(3)}:d=0.6`
  }
];

export interface Transition {
  id: string;
  label: string;
  /** ffmpeg xfade transition name; '' means a hard cut. */
  xfade: string;
}

export const TRANSITIONS: Transition[] = [
  { id: 'none', label: 'None', xfade: '' },
  { id: 'fade', label: 'Dissolve', xfade: 'fade' },
  { id: 'wipeleft', label: 'Wipe left', xfade: 'wipeleft' },
  { id: 'wiperight', label: 'Wipe right', xfade: 'wiperight' },
  { id: 'slideup', label: 'Slide up', xfade: 'slideup' },
  { id: 'slidedown', label: 'Slide down', xfade: 'slidedown' },
  { id: 'circleopen', label: 'Circle open', xfade: 'circleopen' },
  { id: 'fadeblack', label: 'Fade to black', xfade: 'fadeblack' }
];

export const filterById = (id?: string) => FILTERS.find((f) => f.id === id) ?? FILTERS[0];
export const effectById = (id?: string) => EFFECTS.find((e) => e.id === id) ?? EFFECTS[0];
export const transitionById = (id?: string) => TRANSITIONS.find((t) => t.id === id) ?? TRANSITIONS[0];

export const STICKERS = [
  '⭐', '❤️', '🔥', '✨', '💥', '🎉', '👍', '👀',
  '😂', '😍', '😎', '🤔', '😱', '🥳', '💯', '🚀',
  '🎵', '📌', '⚡', '🌈', '☀️', '🌙', '🍿', '🏆'
];

export interface TextPreset {
  id: string;
  label: string;
  text: string;
  fontSize: number;
  color: string;
  bold: boolean;
  shadow: boolean;
  background: string; // '' for none
  fontFamily?: string;
}

export const TEXT_PRESETS: TextPreset[] = [
  { id: 'plain', label: 'Default', text: 'Your text', fontSize: 64, color: '#ffffff', bold: false, shadow: true, background: '', fontFamily: '' },
  { id: 'title', label: 'Title', text: 'TITLE', fontSize: 104, color: '#ffffff', bold: true, shadow: true, background: '', fontFamily: 'CapCut Sans Bold' },
  { id: 'sub', label: 'Subtitle', text: 'Subtitle text', fontSize: 44, color: '#ffffff', bold: false, shadow: true, background: 'rgba(0,0,0,0.55)', fontFamily: 'CapCut Sans Medium' },
  { id: 'accent', label: 'Accent', text: 'Highlight', fontSize: 72, color: '#4d7cfe', bold: true, shadow: false, background: '', fontFamily: 'Bahnschrift' },
  { id: 'badge', label: 'Badge', text: 'NEW', fontSize: 56, color: '#0f0f13', bold: true, shadow: false, background: '#ffd93d', fontFamily: 'Impact' },
  { id: 'quote', label: 'Quote', text: '“Quote”', fontSize: 60, color: '#ffe9a8', bold: false, shadow: true, background: '', fontFamily: 'Source Serif 4 Bold Italic' }
];
