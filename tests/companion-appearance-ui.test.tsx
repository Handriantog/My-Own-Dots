import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { Mascot } from '../src/client/Mascot';
import { DotAppearanceContext } from '../src/client/dot-appearance';
import { DEFAULT_DOT_CUSTOMIZATION } from '../src/shared/dot-customization';
import type { Dot } from '../src/shared/types';
import type { Accessories } from '../src/desktop/shared/accessories';
const render = vi.hoisted(() =>
  vi.fn(
    async (color: string, accessories?: Accessories) =>
      `data:image/png;base64,${Buffer.from(accessories?.headwear === 'beanie' ? `${color}|${accessories.headwear}.${accessories.eyewear}.${accessories.neckwear}` : color).toString('base64')}`,
  ),
);
// The only mocked boundary is GPU rasterization; subscriptions and components are real.
vi.mock('../src/client/companion-avatar-renderer', () => ({
  renderCompanionAvatar: render,
}));
let root: ReactTestRenderer;
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});
it('updates every Dot from native customization and shares one image render per color', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', {
    search: '?surface=workspace&dotColor=%23f5a0be',
  });
  await act(async () => {
    root = create(
      <>
        {Array.from({ length: 40 }, (_, index) => (
          <Mascot key={index} name={`Dot ${index}`} decorative />
        ))}
      </>,
    );
  });
  expect(root.root.findAllByType('img')).toHaveLength(40);
  expect(
    root.root
      .findAllByType('img')
      .every((img) => img.props.src === 'data:image/png;base64,I2Y1YTBiZQ=='),
  ).toBe(true);
  expect(render).toHaveBeenCalledTimes(1);
  await act(async () => {
    location.search = '?surface=workspace&dotColor=%2355aa88';
    window.dispatchEvent(new Event('dot:appearance'));
  });
  expect(
    root.root
      .findAllByType('img')
      .every((img) => img.props.src === 'data:image/png;base64,IzU1YWE4OA=='),
  ).toBe(true);
  expect(render).toHaveBeenCalledTimes(2);
  await act(async () => {
    location.search =
      '?surface=workspace&dotColor=%2355aa88&dotAccessories=beanie.round-glasses.scarf';
    window.dispatchEvent(new Event('dot:appearance'));
  });
  const outfitImage = `data:image/png;base64,${Buffer.from('#55aa88|beanie.round-glasses.scarf').toString('base64')}`;
  expect(
    root.root
      .findAllByType('img')
      .every((img) => img.props.src === outfitImage),
  ).toBe(true);
  expect(render).toHaveBeenCalledTimes(3);
});

it('updates only the customized Dot across repeated avatars, ignoring the desktop color', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', {
    search: '?surface=workspace&dotColor=%23000000',
  });
  const dots = [
    {
      id: 'a',
      customization: { ...DEFAULT_DOT_CUSTOMIZATION, color: '#ab1234' },
    },
    {
      id: 'b',
      customization: { ...DEFAULT_DOT_CUSTOMIZATION, color: '#cd5678' },
    },
  ] as Dot[];
  const scene = (items: Dot[]) => (
    <DotAppearanceContext.Provider value={items}>
      <Mascot identity="a" />
      <Mascot identity="b" />
      <Mascot identity="a" />
    </DotAppearanceContext.Provider>
  );
  await act(async () => {
    root = create(scene(dots));
  });
  const colors = () =>
    root.root
      .findAll((node) => node.props?.className === 'companion-avatar')
      .map((node) => node.props['data-color']);
  expect(colors()).toEqual(['#ab1234', '#cd5678', '#ab1234']);
  await act(async () => {
    root.update(
      scene([
        {
          ...dots[0],
          customization: { ...dots[0].customization!, color: '#ef9012' },
        },
        dots[1],
      ]),
    );
  });
  expect(colors()).toEqual(['#ef9012', '#cd5678', '#ef9012']);
});
