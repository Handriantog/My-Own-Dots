import { expect, it } from 'vitest';
import { parseMemoryCommand } from '../src/shared/memory-commands.js';
it('recognizes only exact owner commands with valid arguments', () => {
  expect(parseMemoryCommand('/compact')).toEqual({ kind: 'compact' });
  expect(parseMemoryCommand(' /dream\n')).toEqual({ kind: 'dream' });
  expect(parseMemoryCommand('/dream-log')).toEqual({ kind: 'dream-log' });
  expect(parseMemoryCommand('/dream-restore abc-123')).toEqual({
    kind: 'dream-restore',
    id: 'abc-123',
  });
  for (const text of [
    'Explain /dream',
    '"/dream"',
    '`/dream`',
    '/dream now',
    '/dream-restore',
    '/dream-restore a b',
    '/dream-restore ../x',
    '/compact\n/dream',
  ])
    expect(parseMemoryCommand(text)).toBeNull();
});
