import { useEffect, useRef } from 'react';

/** Uses the same plush rig and body tint as the desktop companion. */
export function CompanionAvatar({ color }: { color: string }) {
  const container = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import('./companion-avatar-renderer')
      .then(async ({ renderCompanionAvatar }) => {
        if (cancelled) return;
        const avatar = await renderCompanionAvatar(color);
        if (cancelled) avatar.destroy();
        else {
          dispose = avatar.destroy;
          container.current?.append(avatar.canvas);
        }
      })
      .catch((error: unknown) => {
        // Keep the neutral placeholder, and make graphics failures diagnosable.
        console.warn('Companion avatar unavailable:', error);
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [color]);
  return (
    <span className="companion-avatar" ref={container} data-color={color}>
      <span className="companion-avatar-placeholder" aria-hidden="true">
        ◌
      </span>
    </span>
  );
}
