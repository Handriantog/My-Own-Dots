import { expect, it } from 'vitest';
import { memoryTools } from '../src/server/memory-tools.js';
import type { MemoryRecall } from '../src/server/memory-recall.js';
it('enforces the server-bound Dot and cancellation before reading memory', async () => {
  const seen: string[] = [];
  const recall = {
    read: async (dotId: string, id: string) => {
      seen.push(dotId);
      return { id, text: 'Verified preference' };
    },
  } as MemoryRecall;
  const controller = new AbortController();
  const tools = memoryTools(recall, 'bound-dot', () => {}, controller.signal);
  const read = tools.find((tool) => tool.name === 'read_memory')!;
  expect(await read.execute!({ id: 'record' } as never)).toMatchObject({
    text: 'Verified preference',
  });
  expect(seen).toEqual(['bound-dot']);
  controller.abort();
  await expect(read.execute!({ id: 'record' } as never)).rejects.toThrow();
  expect(seen).toHaveLength(1);
});
