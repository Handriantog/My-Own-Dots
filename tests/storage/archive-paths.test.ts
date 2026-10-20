import { describe, expect, it } from 'vitest';
import { validateArchivePaths } from '../../src/server/storage/archive-paths.ts';

describe('portable archive paths', () => {
  it.each([
    '../escape',
    '/absolute',
    'C:/absolute',
    'a/../b',
    'a//b',
    'a/./b',
    'a\\b',
    'a\u0000b',
    'a:stream',
    'name.',
    'name ',
    'CON',
    'aux.txt',
    'LPT9.log',
    'folder/NUL',
    'COM¹.txt',
  ])('rejects unsafe path %j', (path) => {
    expect(() => validateArchivePaths([path])).toThrow();
  });
  it('rejects portable path aliases', () => {
    for (const paths of [
      ['one', 'ONE'],
      ['café', 'cafe\u0301'],
      ['A/b', 'a/C'],
      ['a', 'a/b'],
    ]) {
      expect(() => validateArchivePaths(paths)).toThrow();
    }
  });
  it('accepts portable Unicode paths and shared directories', () => {
    expect(() =>
      validateArchivePaths(['记忆/café.txt', '记忆/voice.json', 'file-1']),
    ).not.toThrow();
  });
  it('enforces UTF-8 path length', () => {
    expect(() => validateArchivePaths(['é'.repeat(513)])).toThrow();
  });
});
