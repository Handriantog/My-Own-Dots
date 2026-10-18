import { CompanionAvatar } from './CompanionAvatar';

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
  return (
    <span className={`mascot ${state} ${small ? 'small' : ''}`}>
      {companionColor ? (
        <span
          role={decorative ? undefined : 'img'}
          aria-label={decorative ? undefined : `${name} is ${state}`}
        >
          <CompanionAvatar color={companionColor} />
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
