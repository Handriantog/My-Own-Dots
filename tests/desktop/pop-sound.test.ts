import { expect, it } from 'vitest';
import { dropletPop } from '../../src/desktop/core/pop-sound.js';

it('makes a short, quiet droplet with a clean onset and decaying tail', () => {
  const samples = dropletPop(48000);
  expect(samples.length / 48000).toBeLessThanOrEqual(0.12);
  expect(samples[0]).toBe(0);
  expect(Math.abs(samples.at(-1)!)).toBeLessThan(0.0001);
  expect(samples.every(Number.isFinite)).toBe(true);
  const peak = Math.max(...samples.map(Math.abs));
  expect(peak).toBeGreaterThan(0.1);
  expect(peak).toBeLessThan(0.5);
  const energy = (values: Float32Array) =>
    values.reduce((sum, n) => sum + n * n, 0) / values.length;
  expect(energy(samples.slice(-960))).toBeLessThan(
    energy(samples.slice(0, 960)) * 0.02,
  );
});
