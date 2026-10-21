import { useEffect, useState } from 'react';
import {
  accessoriesKey,
  DEFAULT_ACCESSORIES,
  type Accessories,
} from '../desktop/shared/accessories';

// Chat history can show hundreds of avatars. Share a raster per color instead
// of allocating a WebGL context for every message, and bound the color cache.
const images = new Map<string, Promise<string>>();
function avatarImage(color: string, accessories: Accessories) {
  const key = `${color}:${accessoriesKey(accessories)}`;
  let image = images.get(key);
  if (!image) {
    image = import('./companion-avatar-renderer').then(
      ({ renderCompanionAvatar }) => renderCompanionAvatar(color, accessories),
    );
    images.set(key, image);
    if (images.size > 32) images.delete(images.keys().next().value!);
    const current = image;
    void image.catch(() => {
      if (images.get(key) === current) images.delete(key);
    });
  }
  return image;
}

/** Uses the desktop companion's exact plush rig and body tint. */
export function CompanionAvatar({
  color,
  accessories = DEFAULT_ACCESSORIES,
}: {
  color: string;
  accessories?: Accessories;
}) {
  const [src, setSrc] = useState('/dots/blue.png');
  useEffect(() => {
    let cancelled = false;
    void avatarImage(color, accessories)
      .then((image) => {
        if (!cancelled) setSrc(image);
      })
      .catch((error: unknown) => {
        console.warn('Companion avatar unavailable:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [color, accessories]);
  return (
    <span className="companion-avatar" data-color={color}>
      <img src={src} alt="" width={128} height={128} draggable={false} />
    </span>
  );
}
