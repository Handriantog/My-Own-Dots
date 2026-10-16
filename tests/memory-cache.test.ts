import { expect, it } from 'vitest';
import { MemoryCache } from '../src/server/memory-cache.js';
it('evicts least recent entries, expires old results, and clears mutations', () => {
  let now = 0;
  const cache = new MemoryCache<string>(2, 100, () => now);
  cache.set('a', 'old');
  cache.set('b', 'second');
  cache.get('a');
  cache.set('c', 'third');
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('a')).toBe('old');
  now = 100;
  expect(cache.get('a')).toBeUndefined();
  cache.set('d', 'fresh');
  cache.clear();
  expect(cache.get('d')).toBeUndefined();
});
