import { expect, it } from 'vitest';
import { MemoryMetrics } from '../src/server/memory-metrics.js';
it('bounds retained samples, separates cache states, and reports actual counts', () => {
  const metrics = new MemoryMetrics(4);
  for (let i = 1; i <= 10; i++) metrics.observe('recall', i, false);
  metrics.observe('recall', 100, true);
  expect(metrics.snapshot().recall).toEqual({
    warm: { count: 10, samples: 4, p50: 8, p95: 10 },
    cold: { count: 1, samples: 1, p50: 100, p95: 100 },
  });
  expect(() => metrics.observe('context', NaN, false)).toThrow();
  expect(JSON.stringify(metrics.snapshot())).not.toContain('prompt');
});
