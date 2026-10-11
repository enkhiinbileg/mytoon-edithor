import type { TextStyle } from './types';

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
  { id: 'plain', label: 'Default', text: 'Default text', fontSize: 64, color: '#ffffff', bold: false, shadow: true, background: '', fontFamily: '' },
  { id: 'title', label: 'Title', text: 'TITLE', fontSize: 104, color: '#ffffff', bold: true, shadow: true, background: '', fontFamily: 'CapCut Sans Bold' },
  { id: 'sub', label: 'Subtitle', text: 'Subtitle text', fontSize: 44, color: '#ffffff', bold: false, shadow: true, background: 'rgba(0,0,0,0.55)', fontFamily: 'CapCut Sans Medium' },
  { id: 'accent', label: 'Accent', text: 'Highlight', fontSize: 72, color: '#4d7cfe', bold: true, shadow: false, background: '', fontFamily: 'Bahnschrift' },
  { id: 'badge', label: 'Badge', text: 'NEW', fontSize: 56, color: '#0f0f13', bold: true, shadow: false, background: '#ffd93d', fontFamily: 'Impact' },
  { id: 'quote', label: 'Quote', text: '“Quote”', fontSize: 60, color: '#ffe9a8', bold: false, shadow: true, background: '', fontFamily: 'Source Serif 4 Bold Italic' }
];

export interface PresetStyle {
  id: string;
  name: string;
  style: Partial<TextStyle>;
  previewStyle: {
    color: string;
    background?: string;
    textShadow?: string;
    WebkitTextStroke?: string;
    border?: string;
    fontWeight?: string | number;
  };
}

/** 22 Authentic CapCut Preset Styles (2 rows of 11 swatches) */
export const PRESET_STYLES: PresetStyle[] = [
  // Row 1
  {
    id: 'plain-white',
    name: 'Plain White',
    style: { color: '#FFFFFF', bold: false, stroke: false, strokeWidth: 0, shadow: false, background: '' },
    previewStyle: { color: '#FFFFFF', fontWeight: 600 }
  },
  {
    id: 'white-black-stroke',
    name: 'White Black Stroke',
    style: { color: '#FFFFFF', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: false, background: '' },
    previewStyle: { color: '#FFFFFF', WebkitTextStroke: '1.5px #000000', fontWeight: 800 }
  },
  {
    id: 'white-shadow',
    name: 'White Shadow',
    style: { color: '#FFFFFF', bold: true, stroke: false, strokeWidth: 0, shadow: true, shadowColor: 'rgba(0,0,0,0.9)', shadowBlur: 10, background: '' },
    previewStyle: { color: '#FFFFFF', textShadow: '0 2px 4px rgba(0,0,0,0.95)', fontWeight: 800 }
  },
  {
    id: 'black-white-stroke',
    name: 'Black White Stroke',
    style: { color: '#000000', bold: true, stroke: true, strokeColor: '#FFFFFF', strokeWidth: 4, shadow: false, background: '' },
    previewStyle: { color: '#000000', WebkitTextStroke: '1.2px #FFFFFF', fontWeight: 800 }
  },
  {
    id: 'yellow-black-stroke',
    name: 'CapCut Yellow',
    style: { color: '#FFE600', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: false, background: '' },
    previewStyle: { color: '#FFE600', WebkitTextStroke: '1.5px #000000', fontWeight: 800 }
  },
  {
    id: 'cyan-black-stroke',
    name: 'Anime Cyan',
    style: { color: '#00F2FE', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: true, shadowColor: '#00F2FE', shadowBlur: 6, background: '' },
    previewStyle: { color: '#00F2FE', WebkitTextStroke: '1.5px #000000', textShadow: '0 0 6px #00F2FE', fontWeight: 800 }
  },
  {
    id: 'orange-black-stroke',
    name: 'Neon Orange',
    style: { color: '#FF7A00', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: false, background: '' },
    previewStyle: { color: '#FF7A00', WebkitTextStroke: '1.5px #000000', fontWeight: 800 }
  },
  {
    id: 'red-black-stroke',
    name: 'Vibrant Red',
    style: { color: '#FF2442', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: false, background: '' },
    previewStyle: { color: '#FF2442', WebkitTextStroke: '1.5px #000000', fontWeight: 800 }
  },
  {
    id: 'pink-white-stroke',
    name: 'Pop Pink',
    style: { color: '#FF007F', bold: true, stroke: true, strokeColor: '#FFFFFF', strokeWidth: 4, shadow: false, background: '' },
    previewStyle: { color: '#FF007F', WebkitTextStroke: '1.2px #FFFFFF', fontWeight: 800 }
  },
  {
    id: 'green-black-stroke',
    name: 'Lime Green',
    style: { color: '#22C55E', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: false, background: '' },
    previewStyle: { color: '#22C55E', WebkitTextStroke: '1.5px #000000', fontWeight: 800 }
  },
  {
    id: 'gold-stroke',
    name: 'Luxury Gold',
    style: { color: '#F59E0B', bold: true, stroke: true, strokeColor: '#78350F', strokeWidth: 5, shadow: true, shadowColor: '#B45309', shadowBlur: 6, background: '' },
    previewStyle: { color: '#F59E0B', WebkitTextStroke: '1.5px #78350F', textShadow: '0 2px 4px #B45309', fontWeight: 800 }
  },

  // Row 2
  {
    id: 'white-badge-black',
    name: 'Black Badge',
    style: { color: '#FFFFFF', bold: true, stroke: false, strokeWidth: 0, shadow: false, background: 'rgba(0,0,0,0.85)' },
    previewStyle: { color: '#FFFFFF', background: '#000000', fontWeight: 800 }
  },
  {
    id: 'yellow-badge-black',
    name: 'Yellow on Black',
    style: { color: '#FFE600', bold: true, stroke: false, strokeWidth: 0, shadow: false, background: 'rgba(0,0,0,0.85)' },
    previewStyle: { color: '#FFE600', background: '#000000', fontWeight: 800 }
  },
  {
    id: 'black-badge-white',
    name: 'White Pill',
    style: { color: '#000000', bold: true, stroke: false, strokeWidth: 0, shadow: false, background: '#FFFFFF' },
    previewStyle: { color: '#000000', background: '#FFFFFF', fontWeight: 800 }
  },
  {
    id: 'white-badge-red',
    name: 'Red Banner',
    style: { color: '#FFFFFF', bold: true, stroke: false, strokeWidth: 0, shadow: false, background: '#DC2626' },
    previewStyle: { color: '#FFFFFF', background: '#DC2626', fontWeight: 800 }
  },
  {
    id: 'white-badge-blue',
    name: 'Blue Banner',
    style: { color: '#FFFFFF', bold: true, stroke: false, strokeWidth: 0, shadow: false, background: '#2563EB' },
    previewStyle: { color: '#FFFFFF', background: '#2563EB', fontWeight: 800 }
  },
  {
    id: 'purple-glow',
    name: 'Cyber Violet',
    style: { color: '#C084FC', bold: true, stroke: true, strokeColor: '#3B0764', strokeWidth: 4, shadow: true, shadowColor: '#A855F7', shadowBlur: 10, background: '' },
    previewStyle: { color: '#C084FC', WebkitTextStroke: '1.2px #3B0764', textShadow: '0 0 8px #A855F7', fontWeight: 800 }
  },
  {
    id: 'neon-cyan-glow',
    name: 'Cyan Neon',
    style: { color: '#FFFFFF', bold: true, stroke: true, strokeColor: '#0891B2', strokeWidth: 4, shadow: true, shadowColor: '#06B6D4', shadowBlur: 12, background: '' },
    previewStyle: { color: '#FFFFFF', WebkitTextStroke: '1.2px #0891B2', textShadow: '0 0 10px #06B6D4', fontWeight: 800 }
  },
  {
    id: 'yellow-3d-shadow',
    name: 'Yellow 3D',
    style: { color: '#FACC15', bold: true, stroke: true, strokeColor: '#713F12', strokeWidth: 4, shadow: true, shadowColor: '#B45309', shadowBlur: 8, background: '' },
    previewStyle: { color: '#FACC15', WebkitTextStroke: '1.2px #713F12', textShadow: '2px 2px 0 #713F12', fontWeight: 800 }
  },
  {
    id: 'chrome-silver',
    name: 'Chrome Silver',
    style: { color: '#E2E8F0', bold: true, stroke: true, strokeColor: '#334155', strokeWidth: 4, shadow: true, shadowColor: '#0F172A', shadowBlur: 6, background: '' },
    previewStyle: { color: '#E2E8F0', WebkitTextStroke: '1.2px #334155', textShadow: '1px 1px 2px #0F172A', fontWeight: 800 }
  },
  {
    id: 'mint-green-stroke',
    name: 'Mint Emerald',
    style: { color: '#6EE7B7', bold: true, stroke: true, strokeColor: '#064E3B', strokeWidth: 5, shadow: false, background: '' },
    previewStyle: { color: '#6EE7B7', WebkitTextStroke: '1.5px #064E3B', fontWeight: 800 }
  },
  {
    id: 'dark-badge-rim',
    name: 'Dark Stealth',
    style: { color: '#F3F4F6', bold: true, stroke: true, strokeColor: '#4B5563', strokeWidth: 3, shadow: false, background: '#1F2937' },
    previewStyle: { color: '#F3F4F6', WebkitTextStroke: '1px #4B5563', background: '#1F2937', fontWeight: 800 }
  }
];

export interface TextArtEffect {
  id: string;
  name: string;
  category: string;
  trending?: boolean;
  style: Partial<TextStyle>;
  previewGradient?: string;
  previewColor: string;
  previewStroke?: string;
  previewShadow?: string;
}

export const EFFECT_CATEGORIES = [
  'Trending',
  'Basic',
  'Luminance',
  'Yellow',
  'Red',
  'Blue',
  'Green',
  'Animation'
] as const;

export const TEXT_EFFECTS: TextArtEffect[] = [
  // ==================== 1. LUMINANCE (NEON & GLOW) ====================
  {
    id: 'art-neon-blue',
    name: 'Neon Tokyo',
    category: 'Luminance',
    trending: true,
    style: { color: '#00F2FE', gradientColors: ['#00F2FE', '#4FACFE'], bold: true, stroke: true, strokeColor: '#004E92', strokeWidth: 6, shadow: true, shadowColor: '#00F2FE', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #00F2FE, #4FACFE)',
    previewColor: '#00F2FE',
    previewStroke: '2px #004E92',
    previewShadow: '0 0 12px #00F2FE'
  },
  {
    id: 'art-laser-cyan',
    name: 'Laser Beam',
    category: 'Luminance',
    trending: true,
    style: { color: '#E0FFFF', gradientColors: ['#FFFFFF', '#00FFFF'], bold: true, stroke: true, strokeColor: '#0891B2', strokeWidth: 5, shadow: true, shadowColor: '#00FFFF', shadowBlur: 16, background: '' },
    previewGradient: 'linear-gradient(135deg, #FFFFFF, #00FFFF)',
    previewColor: '#00FFFF',
    previewStroke: '2px #0891B2',
    previewShadow: '0 0 14px #00FFFF'
  },
  {
    id: 'art-cyber-violet',
    name: 'Cyber Violet',
    category: 'Luminance',
    trending: true,
    style: { color: '#F0ABFC', gradientColors: ['#F0ABFC', '#C026D3'], bold: true, stroke: true, strokeColor: '#4A044E', strokeWidth: 6, shadow: true, shadowColor: '#D946EF', shadowBlur: 15, background: '' },
    previewGradient: 'linear-gradient(135deg, #F0ABFC, #C026D3)',
    previewColor: '#F0ABFC',
    previewStroke: '2px #4A044E',
    previewShadow: '0 0 14px #D946EF'
  },
  {
    id: 'art-neon-pink',
    name: 'Tokyo Neon Pink',
    category: 'Luminance',
    trending: true,
    style: { color: '#FF2A85', gradientColors: ['#FF69B4', '#FF1493'], bold: true, stroke: true, strokeColor: '#70002B', strokeWidth: 6, shadow: true, shadowColor: '#FF007F', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #FF69B4, #FF1493)',
    previewColor: '#FF2A85',
    previewStroke: '2px #70002B',
    previewShadow: '0 0 14px #FF007F'
  },
  {
    id: 'art-radioactive-lime',
    name: 'Radioactive Lime',
    category: 'Luminance',
    trending: true,
    style: { color: '#39FF14', gradientColors: ['#A3E635', '#22C55E'], bold: true, stroke: true, strokeColor: '#052E16', strokeWidth: 6, shadow: true, shadowColor: '#39FF14', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #A3E635, #22C55E)',
    previewColor: '#39FF14',
    previewStroke: '2px #052E16',
    previewShadow: '0 0 14px #39FF14'
  },
  {
    id: 'art-golden-sunburst',
    name: 'Solar Flare',
    category: 'Luminance',
    trending: true,
    style: { color: '#FFF59D', gradientColors: ['#FFF59D', '#F59E0B'], bold: true, stroke: true, strokeColor: '#78350F', strokeWidth: 5, shadow: true, shadowColor: '#F59E0B', shadowBlur: 15, background: '' },
    previewGradient: 'linear-gradient(135deg, #FFF59D, #F59E0B)',
    previewColor: '#FFF59D',
    previewStroke: '2px #78350F',
    previewShadow: '0 0 14px #F59E0B'
  },
  {
    id: 'art-plasma-magenta',
    name: 'Plasma Pulse',
    category: 'Luminance',
    style: { color: '#FF00CC', gradientColors: ['#FF00CC', '#7000FF'], bold: true, stroke: true, strokeColor: '#3B0764', strokeWidth: 6, shadow: true, shadowColor: '#FF00CC', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #FF00CC, #7000FF)',
    previewColor: '#FF00CC',
    previewStroke: '2px #3B0764',
    previewShadow: '0 0 12px #FF00CC'
  },
  {
    id: 'art-biolum-teal',
    name: 'Biolum Abyss',
    category: 'Luminance',
    style: { color: '#2DD4BF', gradientColors: ['#5EEAD4', '#0F766E'], bold: true, stroke: true, strokeColor: '#042F2E', strokeWidth: 6, shadow: true, shadowColor: '#14B8A6', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #5EEAD4, #0F766E)',
    previewColor: '#2DD4BF',
    previewStroke: '2px #042F2E',
    previewShadow: '0 0 12px #14B8A6'
  },
  {
    id: 'art-ultraviolet-arc',
    name: 'Ultraviolet Arc',
    category: 'Luminance',
    style: { color: '#C084FC', gradientColors: ['#E9D5FF', '#9333EA'], bold: true, stroke: true, strokeColor: '#2E1065', strokeWidth: 6, shadow: true, shadowColor: '#9333EA', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #E9D5FF, #9333EA)',
    previewColor: '#C084FC',
    previewStroke: '2px #2E1065',
    previewShadow: '0 0 12px #9333EA'
  },
  {
    id: 'art-supernova-white',
    name: 'Supernova Aura',
    category: 'Luminance',
    style: { color: '#FFFFFF', bold: true, stroke: true, strokeColor: '#7C2D12', strokeWidth: 5, shadow: true, shadowColor: '#F97316', shadowBlur: 16, background: '' },
    previewGradient: 'linear-gradient(180deg, #FFFFFF, #FFF7ED)',
    previewColor: '#FFFFFF',
    previewStroke: '2px #7C2D12',
    previewShadow: '0 0 16px #F97316'
  },

  // ==================== 2. YELLOW & GOLD ====================
  {
    id: 'art-gold-luxury',
    name: '24K Royalty',
    category: 'Yellow',
    trending: true,
    style: { color: '#FDE68A', gradientColors: ['#FFFBEB', '#F59E0B', '#78350F'], bold: true, stroke: true, strokeColor: '#78350F', strokeWidth: 6, shadow: true, shadowColor: '#D97706', shadowBlur: 12, background: '' },
    previewGradient: 'linear-gradient(135deg, #FDE68A, #D97706, #78350F)',
    previewColor: '#FDE68A',
    previewStroke: '2px #78350F',
    previewShadow: '0 0 10px #D97706'
  },
  {
    id: 'art-comic-pop',
    name: 'Comic Pop Star',
    category: 'Yellow',
    trending: true,
    style: { color: '#FACC15', gradientColors: ['#FEF08A', '#EAB308'], bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 8, shadow: true, shadowColor: '#000000', shadowBlur: 0, shadowOffsetX: 4, shadowOffsetY: 4, background: '' },
    previewGradient: 'linear-gradient(135deg, #FEF08A, #EAB308)',
    previewColor: '#FACC15',
    previewStroke: '2.5px #000000',
    previewShadow: '3px 3px 0 #000000'
  },
  {
    id: 'art-cyber-yellow',
    name: 'Cyber Hazard',
    category: 'Yellow',
    trending: true,
    style: { color: '#FFFF00', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 7, shadow: true, shadowColor: '#FFFF00', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(135deg, #FFFF55, #EAB308)',
    previewColor: '#FFFF00',
    previewStroke: '2px #000000',
    previewShadow: '0 0 10px #FFFF00'
  },
  {
    id: 'art-honey-amber',
    name: 'Honey Amber',
    category: 'Yellow',
    style: { color: '#FBBF24', gradientColors: ['#FDE68A', '#D97706'], bold: true, stroke: true, strokeColor: '#451A03', strokeWidth: 6, shadow: true, shadowColor: '#B45309', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(135deg, #FDE68A, #D97706)',
    previewColor: '#FBBF24',
    previewStroke: '2px #451A03',
    previewShadow: '0 0 10px #B45309'
  },
  {
    id: 'art-pixel-gold',
    name: 'Pixel Gold',
    category: 'Yellow',
    style: { color: '#FDE047', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 6, shadow: true, shadowColor: '#854D0E', shadowBlur: 0, shadowOffsetX: 3, shadowOffsetY: 3, background: '' },
    previewGradient: 'linear-gradient(180deg, #FEF08A, #CA8A04)',
    previewColor: '#FDE047',
    previewStroke: '2px #000000',
    previewShadow: '3px 3px 0 #854D0E'
  },
  {
    id: 'art-citrus-punch',
    name: 'Citrus Punch',
    category: 'Yellow',
    style: { color: '#FEF08A', gradientColors: ['#FEF08A', '#EAB308'], bold: true, stroke: true, strokeColor: '#713F12', strokeWidth: 6, shadow: true, shadowColor: '#A16207', shadowBlur: 8, background: '' },
    previewGradient: 'linear-gradient(135deg, #FEF08A, #EAB308)',
    previewColor: '#FEF08A',
    previewStroke: '2px #713F12',
    previewShadow: '0 2px 6px #A16207'
  },
  {
    id: 'art-champagne-gold',
    name: 'Champagne Glow',
    category: 'Yellow',
    style: { color: '#FEF3C7', gradientColors: ['#FFFFFF', '#FDE68A'], bold: true, stroke: true, strokeColor: '#92400E', strokeWidth: 4, shadow: true, shadowColor: '#B45309', shadowBlur: 8, background: '' },
    previewGradient: 'linear-gradient(180deg, #FFFFFF, #FDE68A)',
    previewColor: '#FEF3C7',
    previewStroke: '1.5px #92400E',
    previewShadow: '0 0 8px #B45309'
  },
  {
    id: 'art-warning-sign',
    name: 'Caution Tape',
    category: 'Yellow',
    style: { color: '#EAB308', bold: true, stroke: true, strokeColor: '#18181B', strokeWidth: 8, shadow: true, shadowColor: '#000000', shadowBlur: 4, background: '' },
    previewGradient: 'linear-gradient(135deg, #FACC15, #CA8A04)',
    previewColor: '#EAB308',
    previewStroke: '2.5px #18181B',
    previewShadow: '0 2px 4px #000'
  },
  {
    id: 'art-antique-bronze',
    name: 'Antique Bronze',
    category: 'Yellow',
    style: { color: '#D97706', gradientColors: ['#FBBF24', '#78350F'], bold: true, stroke: true, strokeColor: '#451A03', strokeWidth: 6, shadow: true, shadowColor: '#000000', shadowBlur: 6, background: '' },
    previewGradient: 'linear-gradient(180deg, #FBBF24, #78350F)',
    previewColor: '#D97706',
    previewStroke: '2px #451A03',
    previewShadow: '2px 2px 4px #000'
  },
  {
    id: 'art-lemon-soda',
    name: 'Lemon Soda',
    category: 'Yellow',
    style: { color: '#FEF9C3', gradientColors: ['#FEF9C3', '#FACC15'], bold: true, stroke: true, strokeColor: '#4D7C0F', strokeWidth: 5, shadow: true, shadowColor: '#84CC16', shadowBlur: 8, background: '' },
    previewGradient: 'linear-gradient(135deg, #FEF9C3, #FACC15)',
    previewColor: '#FEF9C3',
    previewStroke: '2px #4D7C0F',
    previewShadow: '0 0 8px #84CC16'
  },

  // ==================== 3. RED & FIRE ====================
  {
    id: 'art-magma-fire',
    name: 'Magma Inferno',
    category: 'Red',
    trending: true,
    style: { color: '#FFED4A', gradientColors: ['#FFED4A', '#EA580C', '#B91C1C'], bold: true, stroke: true, strokeColor: '#7F1D1D', strokeWidth: 6, shadow: true, shadowColor: '#EA580C', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #FFED4A, #EA580C, #B91C1C)',
    previewColor: '#FFED4A',
    previewStroke: '2px #7F1D1D',
    previewShadow: '0 0 14px #EA580C'
  },
  {
    id: 'art-ruby-crimson',
    name: 'Ruby Crimson',
    category: 'Red',
    trending: true,
    style: { color: '#F87171', gradientColors: ['#FCA5A5', '#B91C1C'], bold: true, stroke: true, strokeColor: '#450A0A', strokeWidth: 6, shadow: true, shadowColor: '#DC2626', shadowBlur: 12, background: '' },
    previewGradient: 'linear-gradient(135deg, #FCA5A5, #B91C1C)',
    previewColor: '#F87171',
    previewStroke: '2px #450A0A',
    previewShadow: '0 0 12px #DC2626'
  },
  {
    id: 'art-sunset-orange',
    name: 'Sunset Ember',
    category: 'Red',
    trending: true,
    style: { color: '#FB923C', gradientColors: ['#FDBA74', '#C2410C'], bold: true, stroke: true, strokeColor: '#7C2D12', strokeWidth: 6, shadow: true, shadowColor: '#EA580C', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(135deg, #FDBA74, #C2410C)',
    previewColor: '#FB923C',
    previewStroke: '2px #7C2D12',
    previewShadow: '0 0 10px #EA580C'
  },
  {
    id: 'art-blood-moon',
    name: 'Blood Moon',
    category: 'Red',
    trending: true,
    style: { color: '#EF4444', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 7, shadow: true, shadowColor: '#000000', shadowBlur: 0, shadowOffsetX: 4, shadowOffsetY: 4, background: '' },
    previewGradient: 'linear-gradient(180deg, #F87171, #B91C1C)',
    previewColor: '#EF4444',
    previewStroke: '2px #000000',
    previewShadow: '3px 3px 0 #000000'
  },
  {
    id: 'art-red-alert',
    name: 'Red Alert Neon',
    category: 'Red',
    style: { color: '#FF1E27', bold: true, stroke: true, strokeColor: '#450A0A', strokeWidth: 6, shadow: true, shadowColor: '#FF0000', shadowBlur: 15, background: '' },
    previewGradient: 'linear-gradient(135deg, #FF4B51, #D8000C)',
    previewColor: '#FF1E27',
    previewStroke: '2px #450A0A',
    previewShadow: '0 0 14px #FF0000'
  },
  {
    id: 'art-cherry-velvet',
    name: 'Cherry Velvet',
    category: 'Red',
    style: { color: '#FDA4AF', gradientColors: ['#FDA4AF', '#9F1239'], bold: true, stroke: true, strokeColor: '#4C0519', strokeWidth: 6, shadow: true, shadowColor: '#881337', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(135deg, #FDA4AF, #9F1239)',
    previewColor: '#FDA4AF',
    previewStroke: '2px #4C0519',
    previewShadow: '0 0 10px #881337'
  },
  {
    id: 'art-dragon-breath',
    name: 'Dragon Breath',
    category: 'Red',
    style: { color: '#FDE047', gradientColors: ['#FDE047', '#EF4444', '#7F1D1D'], bold: true, stroke: true, strokeColor: '#450A0A', strokeWidth: 6, shadow: true, shadowColor: '#F97316', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(135deg, #FDE047, #EF4444, #7F1D1D)',
    previewColor: '#FDE047',
    previewStroke: '2px #450A0A',
    previewShadow: '0 0 10px #F97316'
  },
  {
    id: 'art-manga-action-red',
    name: 'Action Red',
    category: 'Red',
    style: { color: '#FF2A2A', bold: true, italic: true, stroke: true, strokeColor: '#000000', strokeWidth: 7, shadow: true, shadowColor: '#7F1D1D', shadowBlur: 4, background: '' },
    previewGradient: 'linear-gradient(180deg, #FF6B6B, #DC2626)',
    previewColor: '#FF2A2A',
    previewStroke: '2px #000000',
    previewShadow: '2px 2px 4px #7F1D1D'
  },
  {
    id: 'art-lava-core',
    name: 'Lava Core',
    category: 'Red',
    style: { color: '#F97316', gradientColors: ['#FDBA74', '#991B1B'], bold: true, stroke: true, strokeColor: '#450A0A', strokeWidth: 6, shadow: true, shadowColor: '#EA580C', shadowBlur: 12, background: '' },
    previewGradient: 'linear-gradient(135deg, #FDBA74, #991B1B)',
    previewColor: '#F97316',
    previewStroke: '2px #450A0A',
    previewShadow: '0 0 12px #EA580C'
  },
  {
    id: 'art-gothic-rose',
    name: 'Gothic Rose',
    category: 'Red',
    style: { color: '#E11D48', gradientColors: ['#FB7185', '#881337'], bold: true, stroke: true, strokeColor: '#1E1B4B', strokeWidth: 5, shadow: true, shadowColor: '#4C0519', shadowBlur: 8, background: '' },
    previewGradient: 'linear-gradient(135deg, #FB7185, #881337)',
    previewColor: '#E11D48',
    previewStroke: '2px #1E1B4B',
    previewShadow: '0 0 8px #4C0519'
  },

  // ==================== 4. BLUE & CYAN ====================
  {
    id: 'art-ice-blizzard',
    name: 'Ice Blizzard',
    category: 'Blue',
    trending: true,
    style: { color: '#E0F2FE', gradientColors: ['#BAE6FD', '#0284C7'], bold: true, stroke: true, strokeColor: '#0369A1', strokeWidth: 6, shadow: true, shadowColor: '#38BDF8', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #BAE6FD, #0284C7)',
    previewColor: '#E0F2FE',
    previewStroke: '2px #0369A1',
    previewShadow: '0 0 12px #38BDF8'
  },
  {
    id: 'art-deep-space',
    name: 'Cosmic Galaxy',
    category: 'Blue',
    trending: true,
    style: { color: '#A5B4FC', gradientColors: ['#C7D2FE', '#4338CA'], bold: true, stroke: true, strokeColor: '#1E1B4B', strokeWidth: 6, shadow: true, shadowColor: '#6366F1', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #C7D2FE, #4338CA)',
    previewColor: '#A5B4FC',
    previewStroke: '2px #1E1B4B',
    previewShadow: '0 0 12px #6366F1'
  },
  {
    id: 'art-electric-cyan',
    name: 'Electric Cyan',
    category: 'Blue',
    trending: true,
    style: { color: '#00E5FF', bold: true, stroke: true, strokeColor: '#003366', strokeWidth: 6, shadow: true, shadowColor: '#00E5FF', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #67E8F9, #06B6D4)',
    previewColor: '#00E5FF',
    previewStroke: '2px #003366',
    previewShadow: '0 0 12px #00E5FF'
  },
  {
    id: 'art-ocean-abyss',
    name: 'Ocean Abyss',
    category: 'Blue',
    style: { color: '#38BDF8', gradientColors: ['#38BDF8', '#0369A1', '#082F49'], bold: true, stroke: true, strokeColor: '#082F49', strokeWidth: 6, shadow: true, shadowColor: '#0284C7', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(180deg, #38BDF8, #082F49)',
    previewColor: '#38BDF8',
    previewStroke: '2px #082F49',
    previewShadow: '0 2px 6px #0284C7'
  },
  {
    id: 'art-frozen-glacier',
    name: 'Frozen Glacier',
    category: 'Blue',
    style: { color: '#A5F3FC', gradientColors: ['#FFFFFF', '#38BDF8'], bold: true, stroke: true, strokeColor: '#164E63', strokeWidth: 5, shadow: true, shadowColor: '#06B6D4', shadowBlur: 12, background: '' },
    previewGradient: 'linear-gradient(135deg, #FFFFFF, #38BDF8)',
    previewColor: '#A5F3FC',
    previewStroke: '2px #164E63',
    previewShadow: '0 0 10px #06B6D4'
  },
  {
    id: 'art-royal-sapphire',
    name: 'Royal Sapphire',
    category: 'Blue',
    style: { color: '#60A5FA', gradientColors: ['#93C5FD', '#1D4ED8'], bold: true, stroke: true, strokeColor: '#172554', strokeWidth: 6, shadow: true, shadowColor: '#1E40AF', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(135deg, #93C5FD, #1D4ED8)',
    previewColor: '#60A5FA',
    previewStroke: '2px #172554',
    previewShadow: '0 0 10px #1E40AF'
  },
  {
    id: 'art-midnight-frost',
    name: 'Midnight Frost',
    category: 'Blue',
    style: { color: '#E0E7FF', gradientColors: ['#E0E7FF', '#818CF8'], bold: true, stroke: true, strokeColor: '#1E1B4B', strokeWidth: 5, shadow: true, shadowColor: '#4338CA', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(135deg, #E0E7FF, #818CF8)',
    previewColor: '#E0E7FF',
    previewStroke: '2px #1E1B4B',
    previewShadow: '0 0 10px #4338CA'
  },
  {
    id: 'art-caribbean-turquoise',
    name: 'Caribbean Turquoise',
    category: 'Blue',
    style: { color: '#22D3EE', gradientColors: ['#67E8F9', '#0891B2'], bold: true, stroke: true, strokeColor: '#164E63', strokeWidth: 6, shadow: true, shadowColor: '#06B6D4', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(135deg, #67E8F9, #0891B2)',
    previewColor: '#22D3EE',
    previewStroke: '2px #164E63',
    previewShadow: '0 0 10px #06B6D4'
  },
  {
    id: 'art-blue-laser',
    name: 'Blue Saber',
    category: 'Blue',
    style: { color: '#FFFFFF', bold: true, stroke: true, strokeColor: '#1E3A8A', strokeWidth: 5, shadow: true, shadowColor: '#3B82F6', shadowBlur: 16, background: '' },
    previewGradient: 'linear-gradient(180deg, #FFFFFF, #DBEAFE)',
    previewColor: '#FFFFFF',
    previewStroke: '2px #1E3A8A',
    previewShadow: '0 0 16px #3B82F6'
  },
  {
    id: 'art-polar-star',
    name: 'Polar Star',
    category: 'Blue',
    style: { color: '#F0F9FF', gradientColors: ['#FFFFFF', '#BAE6FD'], bold: true, stroke: true, strokeColor: '#0C4A6E', strokeWidth: 5, shadow: true, shadowColor: '#38BDF8', shadowBlur: 8, background: '' },
    previewGradient: 'linear-gradient(135deg, #FFFFFF, #BAE6FD)',
    previewColor: '#F0F9FF',
    previewStroke: '2px #0C4A6E',
    previewShadow: '0 0 8px #38BDF8'
  },

  // ==================== 5. GREEN & MATRIX & TOXIC ====================
  {
    id: 'art-emerald-matrix',
    name: 'Emerald Matrix',
    category: 'Green',
    trending: true,
    style: { color: '#34D399', gradientColors: ['#6EE7B7', '#059669'], bold: true, stroke: true, strokeColor: '#064E3B', strokeWidth: 6, shadow: true, shadowColor: '#10B981', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #6EE7B7, #059669)',
    previewColor: '#34D399',
    previewStroke: '2px #064E3B',
    previewShadow: '0 0 12px #10B981'
  },
  {
    id: 'art-toxic-biohazard',
    name: 'Toxic Biohazard',
    category: 'Green',
    trending: true,
    style: { color: '#A3E635', gradientColors: ['#BEF264', '#65A30D'], bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 7, shadow: true, shadowColor: '#84CC16', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #BEF264, #65A30D)',
    previewColor: '#A3E635',
    previewStroke: '2.5px #000000',
    previewShadow: '0 0 14px #84CC16'
  },
  {
    id: 'art-electric-lime',
    name: 'Electric Lime',
    category: 'Green',
    style: { color: '#A3E635', gradientColors: ['#BEF264', '#4D7C0F'], bold: true, stroke: true, strokeColor: '#14532D', strokeWidth: 6, shadow: true, shadowColor: '#65A30D', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(135deg, #BEF264, #4D7C0F)',
    previewColor: '#A3E635',
    previewStroke: '2px #14532D',
    previewShadow: '0 0 10px #65A30D'
  },
  {
    id: 'art-alien-biolum',
    name: 'Alien Glow',
    category: 'Green',
    trending: true,
    style: { color: '#4ADE80', bold: true, stroke: true, strokeColor: '#052E16', strokeWidth: 6, shadow: true, shadowColor: '#22C55E', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #86EFAC, #16A34A)',
    previewColor: '#4ADE80',
    previewStroke: '2px #052E16',
    previewShadow: '0 0 14px #22C55E'
  },
  {
    id: 'art-mint-sorbet',
    name: 'Mint Sorbet',
    category: 'Green',
    style: { color: '#A7F3D0', gradientColors: ['#D1FAE5', '#10B981'], bold: true, stroke: true, strokeColor: '#064E3B', strokeWidth: 5, shadow: true, shadowColor: '#059669', shadowBlur: 8, background: '' },
    previewGradient: 'linear-gradient(135deg, #D1FAE5, #10B981)',
    previewColor: '#A7F3D0',
    previewStroke: '2px #064E3B',
    previewShadow: '0 0 8px #059669'
  },
  {
    id: 'art-forest-canopy',
    name: 'Forest Canopy',
    category: 'Green',
    style: { color: '#86EFAC', gradientColors: ['#BBF7D0', '#15803D'], bold: true, stroke: true, strokeColor: '#052E16', strokeWidth: 6, shadow: true, shadowColor: '#166534', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(135deg, #BBF7D0, #15803D)',
    previewColor: '#86EFAC',
    previewStroke: '2px #052E16',
    previewShadow: '0 2px 6px #166534'
  },
  {
    id: 'art-imperial-jade',
    name: 'Imperial Jade',
    category: 'Green',
    style: { color: '#34D399', gradientColors: ['#6EE7B7', '#047857'], bold: true, stroke: true, strokeColor: '#78350F', strokeWidth: 5, shadow: true, shadowColor: '#D97706', shadowBlur: 8, background: '' },
    previewGradient: 'linear-gradient(135deg, #6EE7B7, #047857)',
    previewColor: '#34D399',
    previewStroke: '2px #78350F',
    previewShadow: '0 0 8px #D97706'
  },
  {
    id: 'art-wasabi-zing',
    name: 'Wasabi Zing',
    category: 'Green',
    style: { color: '#D9F99D', gradientColors: ['#ECFCCB', '#84CC16'], bold: true, stroke: true, strokeColor: '#365314', strokeWidth: 6, shadow: true, shadowColor: '#4D7C0F', shadowBlur: 8, background: '' },
    previewGradient: 'linear-gradient(135deg, #ECFCCB, #84CC16)',
    previewColor: '#D9F99D',
    previewStroke: '2px #365314',
    previewShadow: '0 0 8px #4D7C0F'
  },
  {
    id: 'art-northern-lights',
    name: 'Northern Lights',
    category: 'Green',
    style: { color: '#2DD4BF', gradientColors: ['#2DD4BF', '#4ADE80'], bold: true, stroke: true, strokeColor: '#022C22', strokeWidth: 5, shadow: true, shadowColor: '#10B981', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #2DD4BF, #4ADE80)',
    previewColor: '#2DD4BF',
    previewStroke: '2px #022C22',
    previewShadow: '0 0 14px #10B981'
  },
  {
    id: 'art-terminal-code',
    name: 'Hacker Terminal',
    category: 'Green',
    style: { color: '#22C55E', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: true, shadowColor: '#22C55E', shadowBlur: 10, background: '#052E16' },
    previewGradient: 'linear-gradient(180deg, #4ADE80, #16A34A)',
    previewColor: '#22C55E',
    previewStroke: '1.5px #000000',
    previewShadow: '0 0 8px #22C55E'
  },

  // ==================== 6. BASIC & EDITORIAL ====================
  {
    id: 'art-clean-minimal',
    name: 'Clean Minimal',
    category: 'Basic',
    trending: true,
    style: { color: '#FFFFFF', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 4, shadow: false, background: '' },
    previewGradient: 'linear-gradient(180deg, #FFFFFF, #E2E8F0)',
    previewColor: '#FFFFFF',
    previewStroke: '1.5px #000000'
  },
  {
    id: 'art-youtube-impact',
    name: 'YouTube Impact',
    category: 'Basic',
    trending: true,
    style: { color: '#FFFFFF', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 8, shadow: true, shadowColor: 'rgba(0,0,0,0.8)', shadowBlur: 6, shadowOffsetY: 3, background: '' },
    previewGradient: 'linear-gradient(180deg, #FFFFFF, #CBD5E1)',
    previewColor: '#FFFFFF',
    previewStroke: '3px #000000',
    previewShadow: '0 3px 6px rgba(0,0,0,0.8)'
  },
  {
    id: 'art-dark-titanium',
    name: 'Dark Titanium',
    category: 'Basic',
    style: { color: '#E2E8F0', gradientColors: ['#F1F5F9', '#64748B'], bold: true, stroke: true, strokeColor: '#0F172A', strokeWidth: 6, shadow: true, shadowColor: '#000000', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(180deg, #F1F5F9, #64748B)',
    previewColor: '#E2E8F0',
    previewStroke: '2px #0F172A',
    previewShadow: '0 2px 6px #000000'
  },
  {
    id: 'art-cinema-subtitle',
    name: 'Cinema Subtitle',
    category: 'Basic',
    style: { color: '#F8FAFC', bold: true, stroke: false, strokeWidth: 0, shadow: true, shadowColor: 'rgba(0,0,0,0.95)', shadowBlur: 10, shadowOffsetY: 3, background: '' },
    previewGradient: 'linear-gradient(180deg, #FFFFFF, #F1F5F9)',
    previewColor: '#F8FAFC',
    previewShadow: '0 3px 8px rgba(0,0,0,0.9)'
  },
  {
    id: 'art-newspaper-inverted',
    name: 'Newspaper Monolith',
    category: 'Basic',
    style: { color: '#111827', bold: true, stroke: true, strokeColor: '#FFFFFF', strokeWidth: 4, shadow: true, shadowColor: 'rgba(0,0,0,0.5)', shadowBlur: 4, background: '' },
    previewGradient: 'linear-gradient(180deg, #374151, #111827)',
    previewColor: '#111827',
    previewStroke: '1.5px #FFFFFF',
    previewShadow: '0 2px 4px rgba(0,0,0,0.5)'
  },
  {
    id: 'art-modern-slate',
    name: 'Modern Slate',
    category: 'Basic',
    style: { color: '#F1F5F9', bold: true, stroke: true, strokeColor: '#334155', strokeWidth: 5, shadow: true, shadowColor: '#0F172A', shadowBlur: 6, background: '' },
    previewGradient: 'linear-gradient(180deg, #FFFFFF, #94A3B8)',
    previewColor: '#F1F5F9',
    previewStroke: '2px #334155',
    previewShadow: '0 2px 4px #0F172A'
  },
  {
    id: 'art-editorial-ivory',
    name: 'Editorial Ivory',
    category: 'Basic',
    style: { color: '#FFFBEB', bold: true, italic: true, stroke: true, strokeColor: '#451A03', strokeWidth: 3, shadow: true, shadowColor: 'rgba(0,0,0,0.4)', shadowBlur: 4, background: '' },
    previewGradient: 'linear-gradient(180deg, #FFFBEB, #FEF3C7)',
    previewColor: '#FFFBEB',
    previewStroke: '1.2px #451A03',
    previewShadow: '0 2px 4px rgba(0,0,0,0.4)'
  },
  {
    id: 'art-outline-wire',
    name: 'Cyan Wireframe',
    category: 'Basic',
    style: { color: '#FFFFFF', bold: true, stroke: true, strokeColor: '#00E5FF', strokeWidth: 5, shadow: true, shadowColor: '#00E5FF', shadowBlur: 8, background: '' },
    previewGradient: 'linear-gradient(180deg, #FFFFFF, #E0F2FE)',
    previewColor: '#FFFFFF',
    previewStroke: '2px #00E5FF',
    previewShadow: '0 0 8px #00E5FF'
  },
  {
    id: 'art-dark-pill-box',
    name: 'Black Pill Box',
    category: 'Basic',
    style: { color: '#FFFFFF', bold: true, stroke: false, strokeWidth: 0, shadow: true, shadowColor: 'rgba(0,0,0,0.6)', shadowBlur: 4, background: 'rgba(0,0,0,0.7)', backgroundPadding: 8, backgroundRoundness: 6 },
    previewColor: '#FFFFFF',
    previewStroke: 'none',
    previewShadow: '0 2px 4px rgba(0,0,0,0.6)'
  },
  {
    id: 'art-yellow-bar-sub',
    name: 'Highlight Subtitle',
    category: 'Basic',
    style: { color: '#FFE600', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 6, shadow: true, shadowColor: '#000000', shadowBlur: 2, shadowOffsetY: 2, background: '' },
    previewGradient: 'linear-gradient(180deg, #FFF066, #FFE600)',
    previewColor: '#FFE600',
    previewStroke: '2px #000000',
    previewShadow: '0 2px 2px #000000'
  },

  // ==================== 7. ANIMATION, 3D & RETRO ====================
  {
    id: 'art-chrome-3d',
    name: 'Chrome 3D Metallic',
    category: 'Animation',
    trending: true,
    style: { color: '#F1F5F9', gradientColors: ['#FFFFFF', '#94A3B8', '#334155'], bold: true, stroke: true, strokeColor: '#1E293B', strokeWidth: 6, shadow: true, shadowColor: '#0F172A', shadowBlur: 8, shadowOffsetX: 3, shadowOffsetY: 3, background: '' },
    previewGradient: 'linear-gradient(180deg, #FFFFFF, #94A3B8, #475569)',
    previewColor: '#F1F5F9',
    previewStroke: '2px #1E293B',
    previewShadow: '3px 3px 4px #0F172A'
  },
  {
    id: 'art-vaporwave',
    name: 'Vaporwave 80s',
    category: 'Animation',
    trending: true,
    style: { color: '#38BDF8', gradientColors: ['#38BDF8', '#F43F5E'], bold: true, stroke: true, strokeColor: '#BE185D', strokeWidth: 6, shadow: true, shadowColor: '#F43F5E', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #38BDF8, #F43F5E)',
    previewColor: '#38BDF8',
    previewStroke: '2px #BE185D',
    previewShadow: '0 0 12px #F43F5E'
  },
  {
    id: 'art-pink-sparkle',
    name: 'Pink Sparkle',
    category: 'Animation',
    trending: true,
    style: { color: '#FB7185', gradientColors: ['#FDA4AF', '#E11D48'], bold: true, stroke: true, strokeColor: '#881337', strokeWidth: 6, shadow: true, shadowColor: '#F43F5E', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #FDA4AF, #E11D48)',
    previewColor: '#FB7185',
    previewStroke: '2px #881337',
    previewShadow: '0 0 14px #F43F5E'
  },
  {
    id: 'art-glitch-pop',
    name: 'Cyber Glitch 3D',
    category: 'Animation',
    trending: true,
    style: { color: '#00FFFF', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 6, shadow: true, shadowColor: '#FF0055', shadowBlur: 0, shadowOffsetX: 4, shadowOffsetY: -2, background: '' },
    previewGradient: 'linear-gradient(135deg, #00FFFF, #06B6D4)',
    previewColor: '#00FFFF',
    previewStroke: '2px #000000',
    previewShadow: '3px -2px 0 #FF0055'
  },
  {
    id: 'art-synthwave-sunset',
    name: 'Synthwave Sunset',
    category: 'Animation',
    trending: true,
    style: { color: '#FB923C', gradientColors: ['#FB923C', '#EC4899', '#8B5CF6'], bold: true, stroke: true, strokeColor: '#4C1D95', strokeWidth: 6, shadow: true, shadowColor: '#EC4899', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #FB923C, #EC4899, #8B5CF6)',
    previewColor: '#FB923C',
    previewStroke: '2px #4C1D95',
    previewShadow: '0 0 14px #EC4899'
  },
  {
    id: 'art-3d-block-red',
    name: '3D Extrude Red',
    category: 'Animation',
    style: { color: '#EF4444', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 6, shadow: true, shadowColor: '#000000', shadowBlur: 0, shadowOffsetX: 5, shadowOffsetY: 5, background: '' },
    previewGradient: 'linear-gradient(180deg, #F87171, #DC2626)',
    previewColor: '#EF4444',
    previewStroke: '2px #000000',
    previewShadow: '4px 4px 0 #000000'
  },
  {
    id: 'art-rose-gold',
    name: 'Rose Gold Luxury',
    category: 'Animation',
    trending: true,
    style: { color: '#FFE4E6', gradientColors: ['#FFE4E6', '#FB7185', '#BE185D'], bold: true, stroke: true, strokeColor: '#881337', strokeWidth: 5, shadow: true, shadowColor: '#9F1239', shadowBlur: 10, background: '' },
    previewGradient: 'linear-gradient(135deg, #FFE4E6, #FB7185, #BE185D)',
    previewColor: '#FFE4E6',
    previewStroke: '2px #881337',
    previewShadow: '0 0 10px #9F1239'
  },
  {
    id: 'art-cotton-candy',
    name: 'Cotton Candy Pop',
    category: 'Animation',
    style: { color: '#93C5FD', gradientColors: ['#93C5FD', '#F472B6'], bold: true, stroke: true, strokeColor: '#831843', strokeWidth: 5, shadow: true, shadowColor: '#F472B6', shadowBlur: 12, background: '' },
    previewGradient: 'linear-gradient(135deg, #93C5FD, #F472B6)',
    previewColor: '#93C5FD',
    previewStroke: '2px #831843',
    previewShadow: '0 0 10px #F472B6'
  },
  {
    id: 'art-prismatic-holo',
    name: 'Prismatic Holo',
    category: 'Animation',
    style: { color: '#67E8F9', gradientColors: ['#67E8F9', '#C084FC', '#F472B6'], bold: true, stroke: true, strokeColor: '#3B0764', strokeWidth: 5, shadow: true, shadowColor: '#C084FC', shadowBlur: 14, background: '' },
    previewGradient: 'linear-gradient(135deg, #67E8F9, #C084FC, #F472B6)',
    previewColor: '#67E8F9',
    previewStroke: '2px #3B0764',
    previewShadow: '0 0 12px #C084FC'
  },
  {
    id: 'art-boom-comic-3d',
    name: 'Boom Comic 3D',
    category: 'Animation',
    style: { color: '#FFDF00', bold: true, italic: true, stroke: true, strokeColor: '#DC2626', strokeWidth: 7, shadow: true, shadowColor: '#000000', shadowBlur: 0, shadowOffsetX: 5, shadowOffsetY: 5, background: '' },
    previewGradient: 'linear-gradient(180deg, #FFF066, #FFDF00)',
    previewColor: '#FFDF00',
    previewStroke: '2px #DC2626',
    previewShadow: '4px 4px 0 #000000'
  },
  {
    id: 'art-obsidian-stealth',
    name: 'Obsidian Stealth',
    category: 'Animation',
    style: { color: '#18181B', gradientColors: ['#27272A', '#09090B'], bold: true, stroke: true, strokeColor: '#00E5FF', strokeWidth: 4, shadow: true, shadowColor: '#00E5FF', shadowBlur: 12, background: '' },
    previewGradient: 'linear-gradient(180deg, #27272A, #09090B)',
    previewColor: '#18181B',
    previewStroke: '1.5px #00E5FF',
    previewShadow: '0 0 10px #00E5FF'
  },
  {
    id: 'art-bubblegum-pop',
    name: 'Bubblegum Pop',
    category: 'Animation',
    style: { color: '#F472B6', gradientColors: ['#FBCFE8', '#C084FC'], bold: true, stroke: true, strokeColor: '#FFFFFF', strokeWidth: 5, shadow: true, shadowColor: '#DB2777', shadowBlur: 8, background: '' },
    previewGradient: 'linear-gradient(135deg, #FBCFE8, #C084FC)',
    previewColor: '#F472B6',
    previewStroke: '2px #FFFFFF',
    previewShadow: '0 2px 6px #DB2777'
  }
];

