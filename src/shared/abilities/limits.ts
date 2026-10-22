export const abilityLimits = Object.freeze({
  descriptorBytes: 256 * 1024,
  compressedBytes: 256 * 1024 * 1024,
  extractedBytes: 1024 * 1024 * 1024,
  archiveEntries: 20_000,
  frameBytes: 1024 * 1024,
  responseBytes: 1024 * 1024,
  brokerMs: 30_000,
  invocationMs: 60_000,
  shutdownMs: 2_000,
  oauthStateMs: 300_000,
  ownerResultMs: 600_000,
  activeInvocations: 1,
  workers: 4,
  queuedInvocations: 8,
});

/** Run before recursive validators. Wire input must be plain, bounded JSON. */
export function assertBoundedJson(value: unknown, limit: number): void {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  const encoder = new TextEncoder();
  let bytes = 0;
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 20_000 || item.depth > 24)
      throw new Error('Invalid Ability JSON');
    const current = item.value;
    if (current === null || typeof current === 'boolean') bytes += 5;
    else if (typeof current === 'number' && Number.isFinite(current))
      bytes += String(current).length;
    else if (typeof current === 'string')
      bytes += encoder.encode(current).length + 2;
    else if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) throw new Error('Invalid Ability JSON');
      seen.add(current);
      if (
        !Array.isArray(current) &&
        Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null
      )
        throw new Error('Invalid Ability JSON');
      const entries = Object.entries(current);
      if (entries.length > 20_000) throw new Error('Invalid Ability JSON');
      for (const [key, child] of entries) {
        bytes += encoder.encode(key).length + 4;
        pending.push({ value: child, depth: item.depth + 1 });
      }
      bytes += 2;
    } else throw new Error('Invalid Ability JSON');
    if (bytes > limit) throw new Error('Ability JSON exceeds limit');
  }
  if (encoder.encode(JSON.stringify(value)).length > limit)
    throw new Error('Ability JSON exceeds limit');
}
