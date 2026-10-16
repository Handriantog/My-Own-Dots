export type MemoryStage =
  | 'recall'
  | 'context'
  | 'providerQueue'
  | 'providerExecution'
  | 'tools'
  | 'turn';
interface Samples {
  count: number;
  values: number[];
}
interface Summary {
  count: number;
  samples: number;
  p50: number | null;
  p95: number | null;
}
export type MemoryMetricSnapshot = Record<
  MemoryStage,
  { cold: Summary; warm: Summary }
>;
const stages: MemoryStage[] = [
  'recall',
  'context',
  'providerQueue',
  'providerExecution',
  'tools',
  'turn',
];
/** Process-local bounded timing samples. Never accepts prompts, identifiers, or content. */
export class MemoryMetrics {
  private samples = new Map<string, Samples>();
  constructor(private capacity = 256) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error('Invalid sample capacity');
  }
  observe(stage: MemoryStage, ms: number, cold: boolean): void {
    if (!stages.includes(stage) || !Number.isFinite(ms) || ms < 0)
      throw new Error('Invalid timing sample');
    const key = stage + ':' + cold,
      entry = this.samples.get(key) ?? { count: 0, values: [] };
    entry.count++;
    entry.values.push(ms);
    if (entry.values.length > this.capacity) entry.values.shift();
    this.samples.set(key, entry);
  }
  snapshot(): MemoryMetricSnapshot {
    const summary = (key: string): Summary => {
      const entry = this.samples.get(key),
        values = [...(entry?.values ?? [])].sort((a, b) => a - b);
      const percentile = (p: number) =>
        values.length ? values[Math.ceil(values.length * p) - 1] : null;
      return {
        count: entry?.count ?? 0,
        samples: values.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
      };
    };
    return Object.fromEntries(
      stages.map((stage) => [
        stage,
        { cold: summary(stage + ':true'), warm: summary(stage + ':false') },
      ]),
    ) as MemoryMetricSnapshot;
  }
}
export const memoryMetrics = new MemoryMetrics();
export async function measured<T>(
  stage: MemoryStage,
  work: () => Promise<T>,
  cold = false,
): Promise<T> {
  const began = performance.now();
  try {
    return await work();
  } finally {
    memoryMetrics.observe(stage, performance.now() - began, cold);
  }
}
