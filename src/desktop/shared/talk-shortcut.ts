export const DEFAULT_TALK_SHORTCUT = 'Command+Shift+Space';
const modifiers = ['Command', 'Control', 'Alt', 'Shift'];
const keyPattern =
  /^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Enter|Tab|Backspace|Delete|Escape|Up|Down|Left|Right|Home|End|PageUp|PageDown)$/;

export function validTalkShortcut(value: string): boolean {
  if (value === '') return true;
  const parts = value.split('+');
  const key = parts.pop()!;
  return (
    keyPattern.test(key) &&
    parts.length > 0 &&
    parts.some((part) => part !== 'Shift') &&
    new Set(parts).size === parts.length &&
    parts.every((part) => modifiers.includes(part))
  );
}

export function shortcutFromKey(event: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): string | null {
  let key =
    event.key === ' '
      ? 'Space'
      : event.key.startsWith('Arrow')
        ? event.key.slice(5)
        : event.key.length === 1
          ? event.key.toUpperCase()
          : event.key;
  if (!keyPattern.test(key) && (event.altKey || event.shiftKey)) {
    if (/^Key[A-Z]$/.test(event.code ?? '')) key = event.code!.slice(3);
    else if (/^Digit[0-9]$/.test(event.code ?? '')) key = event.code!.slice(5);
  }
  const value = [
    event.metaKey && 'Command',
    event.ctrlKey && 'Control',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    key,
  ]
    .filter(Boolean)
    .join('+');
  return validTalkShortcut(value) ? value : null;
}

export function shortcutLabel(value: string): string {
  return value
    ? value
        .replaceAll('Command', '⌘')
        .replaceAll('Control', '⌃')
        .replaceAll('Alt', '⌥')
        .replaceAll('Shift', '⇧')
        .replaceAll('+', ' ')
    : 'Disabled';
}
