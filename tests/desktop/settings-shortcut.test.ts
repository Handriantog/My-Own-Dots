import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const script = buildSync({
  entryPoints: ['src/desktop/renderer/settings.ts'],
  bundle: true,
  write: false,
  loader: { '.css': 'empty' },
  format: 'iife',
  platform: 'browser',
}).outputFiles[0].text;
class Node extends EventTarget {
  textContent = '';
  attributes = new Map<string, string>();
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
}
function fixture() {
  const nodes = new Map<string, Node>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, new Node());
    return nodes.get(selector)!;
  };
  let focused = true;
  let nativePaused = false;
  let resolveCapture!: () => void;
  let resetCapture!: () => void;
  const document = {
    querySelector: node,
    activeElement: node('#talk-shortcut'),
    hasFocus: () => focused,
  };
  const window = Object.assign(new EventTarget(), {
    dotSettings: {
      read: () => new Promise(() => {}),
      shortcutStatus: async () => '',
      onShortcutCaptureReset: (callback: () => void) => {
        resetCapture = callback;
      },
      captureShortcut: (active: boolean) => {
        nativePaused = active;
        return active
          ? new Promise<void>((resolve) => {
              resolveCapture = resolve;
            })
          : Promise.resolve();
      },
    },
  });
  runInNewContext(script, { window, document });
  return {
    node,
    resolve: () => resolveCapture(),
    paused: () => nativePaused,
    blur: () => {
      focused = false;
      nativePaused = false;
      window.dispatchEvent(new Event('blur'));
    },
    reset: () => {
      nativePaused = false;
      resetCapture();
    },
  };
}
it('ignores a recording acknowledgement that arrives after the window blurred', async () => {
  const f = fixture();
  const button = f.node('#talk-shortcut');
  button.dispatchEvent(new Event('click'));
  expect(f.paused()).toBe(true);
  f.blur();
  f.resolve();
  await Promise.resolve();
  expect(f.paused()).toBe(false);
  expect(button.attributes.get('aria-pressed')).toBe('false');
});
it('leaves recording when the native host restores a shortcut after renderer recovery', async () => {
  const f = fixture();
  const button = f.node('#talk-shortcut');
  button.dispatchEvent(new Event('click'));
  f.resolve();
  await Promise.resolve();
  expect(button.attributes.get('aria-pressed')).toBe('true');
  f.reset();
  expect(button.attributes.get('aria-pressed')).toBe('false');
  expect(f.paused()).toBe(false);
});
