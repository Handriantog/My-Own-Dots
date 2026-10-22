import { CompanionAvatar } from './CompanionAvatar';
import { useContext } from 'react';
import { DotAppearanceContext } from './dot-appearance';
import { DEFAULT_DOT_CUSTOMIZATION } from '../shared/dot-customization';
import {
  useCompanionAccessories,
  useCompanionColor,
} from './companion-appearance';

const characters = ['blue', 'mint', 'orange', 'purple'] as const;

/** Stable identity keeps each specialist recognizable across views and reloads. */
function characterFor(identity?: string) {
  if (!identity) return characters[0];
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return characters[hash % characters.length];
}

export function Mascot({
  state = 'idle',
  small = false,
  identity,
  name = 'Dot',
  decorative = false,
  companionColor,
}: {
  state?: string;
  small?: boolean;
  identity?: string;
  name?: string;
  decorative?: boolean;
  companionColor?: string;
}) {
  const savedColor = useCompanionColor();
  const sharedAccessories = useCompanionAccessories();
  const dots = useContext(DotAppearanceContext);
  const customization = identity
    ? (dots.find((dot) => dot.id === identity)?.customization ??
      DEFAULT_DOT_CUSTOMIZATION)
    : undefined;
  const accessories = customization?.accessories ?? sharedAccessories;
  const color = customization?.color ?? companionColor ?? savedColor;
  return (
    <span className={`mascot ${state} ${small ? 'small' : ''}`}>
      {color ? (
        <span
          role={decorative ? undefined : 'img'}
          aria-label={decorative ? undefined : `${name} is ${state}`}
        >
          <CompanionAvatar color={color} accessories={accessories} />
        </span>
      ) : (
        <img
          className="dot-body"
          src={`/dots/${characterFor(identity)}.png`}
          alt={decorative ? '' : `${name} is ${state}`}
          width={512}
          height={512}
          draggable={false}
        />
      )}
    </span>
  );
}
