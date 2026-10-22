import { expect, it } from 'vitest';
import {
  ACCESSORIES,
  ACCESSORY_SLOTS,
  DEFAULT_ACCESSORIES,
  accessoriesFromKey,
  accessoriesKey,
  avatarHeight,
} from '../../src/desktop/shared/accessories.js';
import { Wearables } from '../../src/desktop/renderer/wearables.js';
import { initialPose } from '../../src/desktop/core/pose.js';
import { buildWorld } from '../../src/desktop/core/world.js';
import { overlayOrigin } from '../../src/desktop/host/presentation.js';
import {
  DEFAULT_PREFERENCES,
  restorePlacement,
} from '../../src/desktop/host/preferences.js';
import { display, snapshot, windowRect } from './fixtures.js';

it('reserves tall-hat clearance on desktop perches, restored positions and overlay recovery', () => {
  const accessories = {
    ...DEFAULT_ACCESSORIES,
    headwear: 'wizard-hat' as const,
  };
  const height = avatarHeight(accessories);
  const scene = snapshot([windowRect(1, 200, 137)]);
  expect(buildWorld(scene, [display], 0).platforms).toHaveLength(2);
  expect(
    buildWorld(scene, [display], 0, new Set(), height).platforms,
  ).toHaveLength(1);
  const safeScene = snapshot([windowRect(1, 200, display.workArea.y + height)]);
  expect(
    buildWorld(safeScene, [display], 0, new Set(), height).platforms,
  ).toHaveLength(2);
  expect(
    restorePlacement(
      {
        ...DEFAULT_PREFERENCES,
        accessories,
        displayId: display.id,
        placementSpace: 'bounds',
        placement: { x: 0.5, y: 137 / 900 },
      },
      [display],
    ),
  ).toBeUndefined();
  const root = { x: 500, y: 137 };
  expect(
    root.y - overlayOrigin(root, display, false, height).y - height,
  ).toBeGreaterThanOrEqual(0);
});

it('normalizes unknown URL selections and round-trips valid combinations', () => {
  expect(accessoriesFromKey('crown.sunglasses.bandana')).toEqual({
    headwear: 'crown',
    eyewear: 'sunglasses',
    neckwear: 'bandana',
  });
  expect(accessoriesFromKey('missing.sunglasses.scarf')).toEqual({
    headwear: 'headphones',
    eyewear: 'sunglasses',
    neckwear: 'scarf',
  });
  expect(accessoriesFromKey('broken')).toEqual(DEFAULT_ACCESSORIES);
  expect(accessoriesKey(accessoriesFromKey('none.none.none'))).toBe(
    'none.none.none',
  );
});

it('keeps every wearable inside its portrait bounds and clears it when removed', () => {
  const wearables = new Wearables();
  try {
    for (const slot of ACCESSORY_SLOTS) {
      for (const option of ACCESSORIES[slot]) {
        if (['none', 'headphones'].includes(option.id)) continue;
        const outfit = { ...DEFAULT_ACCESSORIES, [slot]: option.id };
        wearables.update(outfit, initialPose());
        const bounds = wearables.container.getLocalBounds();
        expect(bounds.width, option.id).toBeGreaterThan(0);
        expect(bounds.minY, option.id).toBeGreaterThanOrEqual(
          -avatarHeight(outfit),
        );
        expect(bounds.maxY, option.id).toBeLessThanOrEqual(0);
        expect(bounds.minX, option.id).toBeGreaterThanOrEqual(-60);
        expect(bounds.maxX, option.id).toBeLessThanOrEqual(60);
        wearables.update(DEFAULT_ACCESSORIES, initialPose());
        expect(
          wearables.container.getLocalBounds().width,
          `remove ${option.id}`,
        ).toBe(0);
      }
    }
  } finally {
    wearables.container.destroy({ children: true });
  }
});
