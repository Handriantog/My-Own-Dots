import { describe, expect, it, vi } from 'vitest';
import { TalkShortcut } from '../../src/desktop/host/talk-shortcut';
import {
  shortcutFromKey,
  validTalkShortcut,
} from '../../src/desktop/shared/talk-shortcut';

describe('windowless talk shortcut', () => {
  it('records modified keys, including Command Shift Space, without accepting bare keys', () => {
    expect(shortcutFromKey({ key: ' ', metaKey: true, shiftKey: true })).toBe(
      'Command+Shift+Space',
    );
    expect(shortcutFromKey({ key: 'y', ctrlKey: true, altKey: true })).toBe(
      'Control+Alt+Y',
    );
    expect(shortcutFromKey({ key: 'a' })).toBeNull();
    expect(shortcutFromKey({ key: 'Shift', metaKey: true })).toBeNull();
    for (const value of [
      'Space',
      'Shift+Y',
      'Command++Y',
      'Command+Command+Y',
      'Command+Invalid',
    ])
      expect(validTalkShortcut(value)).toBe(false);
    expect(validTalkShortcut('')).toBe(true);
    expect(validTalkShortcut('Command+Shift+Space')).toBe(true);
  });
  it('keeps the previous shortcut on conflicts and releases it after a successful replacement', () => {
    const bound = new Map<string, () => void>();
    const api = {
      register: vi.fn((key: string, callback: () => void) => {
        if (key === 'Command+X') return false;
        bound.set(key, callback);
        return true;
      }),
      unregister: vi.fn((key: string) => {
        bound.delete(key);
      }),
    };
    const toggle = vi.fn();
    const shortcut = new TalkShortcut(api, toggle);
    shortcut.set('Command+Shift+Space');
    expect(() => shortcut.set('Command+X')).toThrow(/in use|unavailable/);
    bound.get('Command+Shift+Space')!();
    expect(toggle).toHaveBeenCalledOnce();
    shortcut.set('Command+Shift+Y');
    expect([...bound.keys()]).toEqual(['Command+Shift+Y']);
    shortcut.pause(true);
    expect(bound.size).toBe(0);
    shortcut.pause(false);
    expect([...bound.keys()]).toEqual(['Command+Shift+Y']);
    shortcut.set('');
    expect(bound.size).toBe(0);
    shortcut.destroy();
  });
});

it('records macOS Option symbols and shifted number keys using their base key', () => {
  expect(shortcutFromKey({ key: 'å', code: 'KeyA', altKey: true })).toBe(
    'Alt+A',
  );
  expect(
    shortcutFromKey({ key: '¥', code: 'KeyY', altKey: true, metaKey: true }),
  ).toBe('Command+Alt+Y');
  expect(
    shortcutFromKey({
      key: '!',
      code: 'Digit1',
      metaKey: true,
      shiftKey: true,
    }),
  ).toBe('Command+Shift+1');
});
