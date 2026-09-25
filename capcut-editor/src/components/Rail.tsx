import { Icon } from '../Icons';

export const RAIL_TABS = [
  { id: 'media', label: 'Media', icon: 'media' },
  { id: 'audio', label: 'Audio', icon: 'audio' },
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'stickers', label: 'Stickers', icon: 'sticker' },
  { id: 'effects', label: 'Effects', icon: 'effect' },
  { id: 'transitions', label: 'Transitions', icon: 'transition' },
  { id: 'filters', label: 'Filters', icon: 'filter' },
  { id: 'dub', label: 'Auto dub', icon: 'dub' }
] as const;

export type RailTab = (typeof RAIL_TABS)[number]['id'];

export default function Rail({
  active,
  onChange
}: {
  active: RailTab;
  onChange: (t: RailTab) => void;
}) {
  return (
    <nav className="rail">
      {RAIL_TABS.map((t) => (
        <button
          key={t.id}
          className={'rail-item' + (active === t.id ? ' active' : '')}
          onClick={() => onChange(t.id)}
        >
          <Icon name={t.icon} />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
