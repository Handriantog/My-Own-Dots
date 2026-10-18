import type { Point, PointerInput, Rect } from '../shared/contracts.js';

/** Matches the simulation's four-pixel pickup threshold. */
export class CompanionClick {
  private start: Point | null = null;
  private dragged = false;

  pointer(input: PointerInput): boolean {
    if (input.kind === 'down') {
      this.start = { ...input.point };
      this.dragged = false;
    }
    if (
      this.start &&
      Math.hypot(input.point.x - this.start.x, input.point.y - this.start.y) >=
        4
    )
      this.dragged = true;
    const clicked = input.kind === 'up' && !!this.start && !this.dragged;
    if (input.kind === 'up' || input.kind === 'cancel') this.start = null;
    return clicked;
  }
}

export interface CompanionMenuLayout {
  bounds: Rect;
  root: Point;
  items: Record<'chat' | 'talk' | 'hide', Rect>;
}

/** Small clouds around the body, whose root is at its feet. */
export function companionMenuLayout(
  root: Point,
  area: Rect,
): CompanionMenuLayout {
  const width = 112;
  const height = 58;
  const padding = 4;
  const left = area.x + padding;
  const top = area.y + padding;
  const right = area.x + area.width - padding;
  const bottom = area.y + area.height - padding;
  const clamp = (value: number, min: number, max: number) =>
    Math.round(Math.max(min, Math.min(value, max))) || 0;
  const cloud = (x: number, y: number): Rect => ({
    x: clamp(x, left, right - width),
    y: clamp(y, top, bottom - height),
    width,
    height,
  });
  const leftFits = root.x - 54 - width >= left;
  const rightFits = root.x + 54 + width <= right;
  const aboveFits = root.y - 118 - height >= top;
  let items: CompanionMenuLayout['items'];
  if (leftFits && rightFits) {
    items = {
      chat: cloud(root.x - 54 - width, root.y - 116),
      talk: cloud(
        root.x - width / 2,
        aboveFits ? root.y - 118 - height : root.y + 6,
      ),
      hide: cloud(root.x + 54, root.y - 116),
    };
  } else {
    // At a side/corner, bend the arc into the available screen space.
    const x = !leftFits ? root.x + 54 : root.x - 54 - width;
    const y = clamp(root.y - 118 - height, top, bottom - (height * 3 + 4));
    items = {
      chat: cloud(aboveFits ? root.x - width / 2 : x, y),
      talk: cloud(x, y + height + 2),
      hide: cloud(x, y + (height + 2) * 2),
    };
  }
  const rects = Object.values(items);
  const x = Math.min(...rects.map((item) => item.x)) - padding;
  const y = Math.min(...rects.map((item) => item.y)) - padding;
  return {
    root,
    items,
    bounds: {
      x: x || 0,
      y: y || 0,
      width:
        Math.max(...rects.map((item) => item.x + item.width)) + padding - x,
      height:
        Math.max(...rects.map((item) => item.y + item.height)) + padding - y,
    },
  };
}

export function companionPanelBounds(
  root: Point,
  area: Rect,
  requestedWidth: number,
  requestedHeight: number,
): Rect {
  const width = Math.min(requestedWidth, area.width - 16);
  const height = Math.min(requestedHeight, area.height - 16);
  const right = root.x + 68;
  const x =
    right + width <= area.x + area.width - 8 ? right : root.x - 68 - width;
  return {
    x:
      Math.round(
        Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8)),
      ) || 0,
    y:
      Math.round(
        Math.max(
          area.y + 8,
          Math.min(root.y - 112, area.y + area.height - height - 8),
        ),
      ) || 0,
    width,
    height,
  };
}

export function workspaceAddress(value = 'http://127.0.0.1:4310/'): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/'
  )
    throw new Error(
      'Use your local workspace address, such as http://127.0.0.1:4310.',
    );
  return url.origin + '/';
}
