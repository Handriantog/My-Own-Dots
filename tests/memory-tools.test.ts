import { expect, it } from 'vitest';
import { memoryTools } from '../src/server/memory-tools.js';
import type { MemoryRecall } from '../src/server/memory-recall.js';
it('enforces the server-bound Dot and cancellation before reading memory', async () => {
  const seen: string[] = [];
  const recall = {
    read: async (dotId: string, id: string) => {
      seen.push(dotId);
      return { id, text: 'Verified preference', sources: [], sourceIds: [] };
    },
  } as unknown as MemoryRecall;
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

it('persists recalled provenance and rechecks access before returning evidence', async () => {
  let revoked = false;
  const guard = {
    originDotId: 'origin',
    spaceIds: ['space'],
    pageIds: ['page'],
  };
  const source = {
    threadId: 't',
    runId: 'r',
    messageIds: ['m'],
    contentHash: 'hash',
    guard,
  };
  const recall = {
    read: async () => ({
      id: 'm',
      text: 'secret',
      sources: [source],
      sourceIds: ['s'],
    }),
  } as unknown as MemoryRecall;
  const seen: unknown[] = [];
  const tools = memoryTools(
    recall,
    'dot',
    () => {
      if (revoked) throw new Error('revoked');
    },
    new AbortController().signal,
    async (ref) => {
      seen.push(ref);
      revoked = true;
    },
  );
  await expect(
    tools.find((t) => t.name === 'read_memory')!.execute!({ id: 'm' } as never),
  ).rejects.toThrow('revoked');
  expect(seen).toEqual([guard]);
});
