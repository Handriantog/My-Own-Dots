/** Bounded LRU cache. Callers still reauthorize cached values. */
export class MemoryCache<T> {
  private entries = new Map<string, { value: T; until: number }>();
  constructor(
    private maxEntries = 256,
    private ttlMs = 30_000,
    private clock = Date.now,
  ) {
    if (maxEntries < 1 || ttlMs < 1) throw new Error('Invalid cache bounds');
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.until <= this.clock()) return;
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }
  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, {
      value: structuredClone(value),
      until: this.clock() + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries)
      this.entries.delete(this.entries.keys().next().value!);
  }
  clear(): void {
    this.entries.clear();
  }
}
