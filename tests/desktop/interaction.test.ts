import { describe, expect, it } from 'vitest';
import {
  CompanionClick,
  companionMenuLayout,
  companionPanelBounds,
  workspaceAddress,
} from '../../src/desktop/host/interaction.js';
import type { PointerInput, Rect } from '../../src/desktop/shared/contracts.js';

describe('compact cloud placement', () => {
  const area = { x: 0, y: 0, width: 1512, height: 982 };
  const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;
  it('hugs the left, top, and right of Dot, including on the screen floor', () => {
    const root = { x: 756, y: 982 };
    const { items } = companionMenuLayout(root, area);
    expect(items.chat.x + items.chat.width).toBe(root.x - 54);
    expect(items.talk.y + items.talk.height).toBe(root.y - 118);
    expect(items.hide.x).toBe(root.x + 54);
    expect(items.chat.width).toBe(112);
    expect(items.chat.height).toBe(58);
    expect(items.chat.y - (items.talk.y + items.talk.height)).toBe(2);
  });
  it.each([
    [52, 982],
    [1460, 982],
    [756, 112],
    [52, 112],
    [1460, 112],
    [756, 500],
  ])('keeps all clouds visible and clear of Dot at (%s, %s)', (x, y) => {
    const root = { x, y };
    const layout = companionMenuLayout(root, area);
    const body = { x: x - 52, y: y - 112, width: 104, height: 112 };
    const items = Object.values(layout.items);
    for (const item of [layout.bounds, ...items]) {
      expect(item.x).toBeGreaterThanOrEqual(area.x);
      expect(item.y).toBeGreaterThanOrEqual(area.y);
      expect(item.x + item.width).toBeLessThanOrEqual(area.width);
      expect(item.y + item.height).toBeLessThanOrEqual(area.height);
    }
    for (const [index, item] of items.entries()) {
      expect(overlaps(item, body)).toBe(false);
      for (const other of items.slice(index + 1))
        expect(overlaps(item, other)).toBe(false);
    }
  });
  it('preserves placement on displays with negative coordinates', () => {
    const normal = companionMenuLayout({ x: 756, y: 500 }, area);
    const shifted = companionMenuLayout(
      { x: 756 - 1512, y: 500 - 982 },
      { ...area, x: -1512, y: -982 },
    );
    for (const action of ['chat', 'talk', 'hide'] as const) {
      expect(shifted.items[action]).toEqual({
        ...normal.items[action],
        x: normal.items[action].x - 1512,
        y: normal.items[action].y - 982,
      });
    }
  });
});

describe('companion click', () => {
  const input = (kind: PointerInput['kind'], x = 100): PointerInput => ({
    kind,
    point: { x, y: 100 },
    atMs: 0,
  });
  it('opens once on release, including native-helper releases', () => {
    const click = new CompanionClick();
    expect(click.pointer(input('down'))).toBe(false);
    expect(click.pointer(input('move', 102))).toBe(false);
    expect(click.pointer(input('up', 102))).toBe(true);
    expect(click.pointer(input('up', 102))).toBe(false);
  });
  it('does not open after pickup, even when dragged back to the start', () => {
    const click = new CompanionClick();
    click.pointer(input('down'));
    click.pointer(input('move', 104));
    expect(click.pointer(input('up'))).toBe(false);
  });
  it('ignores cancellation and release-only movement', () => {
    const click = new CompanionClick();
    click.pointer(input('down'));
    click.pointer(input('cancel'));
    expect(click.pointer(input('up'))).toBe(false);
    click.pointer(input('down'));
    expect(click.pointer(input('up', 120))).toBe(false);
  });
});

describe('floating panel placement', () => {
  const area = { x: -1440, y: 25, width: 1440, height: 825 };
  it('opens beside Dot and flips left at the right screen edge', () => {
    expect(companionPanelBounds({ x: -1300, y: 500 }, area, 420, 600)).toEqual({
      x: -1232,
      y: 242,
      width: 420,
      height: 600,
    });
    expect(companionPanelBounds({ x: -70, y: 850 }, area, 420, 600)).toEqual({
      x: -558,
      y: 242,
      width: 420,
      height: 600,
    });
  });
  it('keeps the panel within a small display', () => {
    expect(
      companionPanelBounds(
        { x: 30, y: 20 },
        { x: 0, y: 0, width: 320, height: 400 },
        420,
        600,
      ),
    ).toEqual({ x: 8, y: 8, width: 304, height: 384 });
  });
  it('never passes signed zero coordinates to native windows', () => {
    const bounds = companionPanelBounds(
      { x: -68.1, y: 111.9 },
      { x: -1440, y: -900, width: 2880, height: 1800 },
      420,
      600,
    );
    expect(Object.is(bounds.x, -0)).toBe(false);
    expect(Object.is(bounds.y, -0)).toBe(false);
  });
});

describe('workspace address', () => {
  it('uses the local server and preserves a managed port', () => {
    expect(workspaceAddress()).toBe('http://127.0.0.1:4310/');
    expect(workspaceAddress('http://localhost:5173/?desktop=1')).toBe(
      'http://localhost:5173/',
    );
  });
  it.each([
    'https://example.com',
    'file:///etc/passwd',
    'http://localhost.evil.test',
    'http://user:secret@localhost:4310',
    'javascript:alert(1)',
    'http://127.0.0.1:4310/proxy',
  ])('rejects nonlocal or ambiguous addresses: %s', (address) => {
    expect(() => workspaceAddress(address)).toThrow();
  });
});
