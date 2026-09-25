import type { SVGProps } from 'react';

// Single-path (or few-path) 24x24 stroke icons, sized by CSS.
const paths: Record<string, string[]> = {
  duplicate: ['M8 8h12v12H8z', 'M16 8V4H4v12h4'],
  unlock: ['M6 11h12v9H6z', 'M9 11V8a3 3 0 0 1 6 0'],
  media: ['M3 5h18v14H3z', 'M3 9h18', 'M8 5v4', 'M14 5v4'],
  audio: ['M9 18V6l10-2v12', 'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
  text: ['M5 6h14', 'M12 6v12', 'M9 18h6'],
  sticker: ['M12 3a9 9 0 1 0 9 9h-6a3 3 0 0 1-3-3V3z'],
  effect: ['M12 3l2.2 5.3L20 9.5l-4 3.9.9 5.6L12 16.4 7.1 19l.9-5.6-4-3.9 5.8-1.2z'],
  transition: ['M4 5h7v14H4z', 'M13 5h7v14h-7z', 'M11 12h2'],
  filter: ['M3 5h18l-7 8v6l-4 2v-8z'],
  dub: ['M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'],

  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  scissors: ['M6 4l12 12', 'M18 4L6 16', 'M8 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M21 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z'],
  trash: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13'],
  undo: ['M4 10h10a5 5 0 0 1 0 10H9', 'M4 10l4-4', 'M4 10l4 4'],
  redo: ['M20 10H10a5 5 0 0 0 0 10h5', 'M20 10l-4-4', 'M20 10l-4 4'],
  magnet: ['M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z'],
  follow: ['M12 2v20', 'M8 3h8v5l-4 4-4-4V3z'],
  split: ['M12 3v18', 'M7 8l5 4-5 4', 'M17 8l-5 4 5 4'],
  ripple: ['M12 4v16', 'M4 12h5', 'M7 9l3 3-3 3', 'M20 12h-5', 'M17 9l-3 3 3 3'],

  play: ['M8 5l12 7-12 7z'],
  pause: ['M9 5v14', 'M15 5v14'],
  skipBack: ['M18 5v14L8 12z', 'M6 5v14'],
  skipFwd: ['M6 5v14l10-7z', 'M18 5v14'],

  zoomIn: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4.5-4.5', 'M11 8v6', 'M8 11h6'],
  zoomOut: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4.5-4.5', 'M8 11h6'],
  fit: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  expand: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
  collapse: ['M4 14h6v6', 'M20 10h-6V4', 'M14 10l7-7', 'M10 14l-7 7'],

  eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  eyeOff: ['M4 4l16 16', 'M2 12s4-7 10-7c2 0 3.7.8 5.1 1.8M22 12s-4 7-10 7c-2 0-3.7-.8-5.1-1.8'],
  volume: ['M4 9v6h4l5 4V5L8 9z', 'M17 9a4 4 0 0 1 0 6'],
  volumeOff: ['M4 9v6h4l5 4V5L8 9z', 'M17 10l4 4', 'M21 10l-4 4'],
  lock: ['M6 11h12v9H6z', 'M9 11V8a3 3 0 0 1 6 0v3'],

  export: ['M12 3v12', 'M8 11l4 4 4-4', 'M4 19h16'],
  folder: ['M3 6h6l2 2h10v11H3z'],
  open: ['M3 6h6l2 2h10v11H3z'],

  home: ['M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5z'],
  templates: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  video: ['M15 10l5-3v10l-5-3z', 'M3 6h12v12H3z'],
  design: ['M12 2l8 8-8 8-8-8z', 'M12 7v10'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4.5-4.5'],
  grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h1', 'M3 12h1', 'M3 18h1'],
  refresh: ['M21.5 2v6h-6', 'M21.34 15.57a10 10 0 1 1-.57-8.38l6.73-5.19'],
  more: ['M12 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M12 21a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'],

  min: ['M5 12h14'],
  max: ['M5 5h14v14H5z'],
  close: ['M6 6l12 12', 'M18 6L6 18']
};

interface Props extends SVGProps<SVGSVGElement> {
  name: keyof typeof paths | string;
  filled?: boolean;
}

export function Icon({ name, filled, ...rest }: Props) {
  const d = paths[name] ?? [];
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}
