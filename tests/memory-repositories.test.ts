import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { evidenceHash } from '../src/server/conversation-memory.js';
import { memoryRepositories } from './fixtures/memory-repositories.js';
import type { ContextCheckpoint } from '../src/server/context-compaction.js';
import type { Message, RunAgentInput } from '@ag-ui/core';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(adapter: 'postgres' | 'sqlite', entry?: URL) {
  const f = await memoryRepositories(adapter, entry);
  cleanups.push(f.close);
  const dot = (await f.workspace.dots())[0];
  const threadId = randomUUID();
  await f.workspace.bindThread(threadId, dot.id, 'Evidence');
  await f.conversations.createThread({
    threadId,
    agentId: dot.id,
    userId: f.owner,
  });
  const lease = (await f.conversations.acquireThread(threadId))!;
  const input: RunAgentInput = {
    threadId,
    runId: randomUUID(),
    messages: [
      {
        id: 'user',
        role: 'user',
        content: 'I prefer opalword tea without sugar.',
      },
    ],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const guard = { originDotId: dot.id, spaceIds: [dot.spaceId], pageIds: [] };
  const messages: Message[] = [
    ...input.messages,
    {
      id: 'assistant',
      role: 'assistant',
      content: 'Remembered opalword tea preference.',
    },
  ];
  await lease.beginRun(input, guard);
  await lease.finishRun(messages, {}, 'finished');
  await lease.release();
  return { ...f, dot, threadId, input, guard, messages };
}
for (const adapter of ['postgres', 'sqlite'] as const)
  describe.skipIf(
    adapter === 'postgres' && !process.env.LOCAL_TEST_DATABASE_URL,
  )(adapter, () => {
    it('indexes sources once, filters scope, and stops recalling forgotten or revoked evidence', async () => {
      const f = await fixture(adapter);
      await f.evidence.indexRun(f.input.runId);
      await f.evidence.indexRun(f.input.runId);
      expect(await f.evidence.coverage(f.dot.id)).toMatchObject({
        indexedRuns: 1,
        eligibleRuns: 1,
        complete: true,
      });
      const found = await f.evidence.searchEpisodes({
        allowedThreadIds: [f.threadId],
        query: 'opalword',
      });
      expect(found.matches).toHaveLength(2);
      expect(
        (
          await f.evidence.searchEpisodes({
            allowedThreadIds: ['unbound'],
            query: 'opalword',
          })
        ).matches,
      ).toEqual([]);
      const source = found.matches.find((row) => row.role === 'user')!;
      expect(
        await f.evidence.readSource({
          ...source.source,
          contentHash: 'f'.repeat(64),
        }),
      ).toBeUndefined();
      expect(
        (
          await f.recall.search(f.dot.id, {
            query: 'opalword',
            kinds: ['episode'],
          })
        ).matches,
      ).toHaveLength(2);
      await f.workspace.memory.history.suppress([source.source], 'forgotten');
      expect(
        (
          await f.recall.search(f.dot.id, {
            query: 'opalword',
            kinds: ['episode'],
          })
        ).matches.map((row) => row.id),
      ).not.toContain(source.id);
      const nextSpace = await f.workspace.createSpace(
        'Other',
        'No original grant',
      );
      await f.workspace.updateDot(f.dot.id, {
        ...f.dot,
        spaceId: nextSpace.id,
        spaceIds: [nextSpace.id],
      });
      expect(await f.evidence.sourceById(source.id)).toBeUndefined();
      expect(
        (
          await f.recall.search(f.dot.id, {
            query: 'opalword',
            kinds: ['episode'],
          })
        ).matches,
      ).toEqual([]);
    });
    it('stores checkpoints only for an unchanged canonical prefix', async () => {
      const f = await fixture(adapter);
      const checkpoint: ContextCheckpoint = {
        id: randomUUID(),
        threadId: f.threadId,
        schemaVersion: 1,
        sourceMessageIds: ['user'],
        sourceHash: evidenceHash([f.messages[0]]),
        permissionGeneration: 'fixture',
        suppressionGeneration: 0,
        goal: 'Tea preference',
        constraints: [],
        decisions: [],
        completedWork: [],
        openQuestions: [],
        nextSteps: [],
        evidenceMessageIds: ['user'],
        createdAt: Date.now(),
      };
      expect(await f.evidence.saveCheckpoint(checkpoint, 'stale')).toBe(false);
      expect(
        await f.evidence.saveCheckpoint(checkpoint, checkpoint.sourceHash),
      ).toBe(true);
      expect(await f.evidence.latestCheckpoint(f.threadId)).toEqual(checkpoint);
      expect(
        await f.evidence.latestCheckpoint(f.threadId, [
          { id: 'user', role: 'user', content: 'Changed prefix' },
        ]),
      ).toBeUndefined();
    });
    it('coalesces jobs, fences stale ownership, and enforces concurrent daily admission', async () => {
      const f = await fixture(adapter);
      const input = {
        kind: 'dream' as const,
        dotId: f.dot.id,
        sourceIds: [],
        origin: 'manual' as const,
        logicalKey: 'manual',
      };
      const job = await f.jobs.enqueue(input);
      expect((await f.jobs.enqueue(input)).id).toBe(job.id);
      const claimed = (await f.jobs.claim())!;
      expect(claimed.id).toBe(job.id);
      await expect(
        f.jobs.recordUsage(job.id, 'stale-token', { modelCalls: 1 }),
      ).rejects.toThrow(/lease/i);
      await f.jobs.recordUsage(job.id, claimed.leaseToken!, {
        modelCalls: 1,
        elapsedMs: 20,
      });
      await f.jobs.settle(job.id, claimed.leaseToken!, { state: 'succeeded' });
      expect((await f.jobs.get(job.id))?.modelCalls).toBe(1);
      const automatic = await Promise.all(
        ['auto-a', 'auto-b'].map((logicalKey) =>
          f.jobs.enqueue({ ...input, origin: 'automatic', logicalKey }),
        ),
      );
      const admitted = await Promise.all(
        automatic.map((job) => f.jobs.admitAutomatic(job.id, '2026-10-20', 1)),
      );
      expect(admitted.filter(Boolean)).toHaveLength(1);
    });
  });
for (const adapter of ['postgres', 'sqlite'] as const)
  describe.skipIf(
    adapter === 'postgres' && !process.env.LOCAL_TEST_DATABASE_URL,
  )(adapter + ' publication', () => {
    it('publishes once and acknowledges analyzed sources without allowing stale or foreign job claims', async () => {
      const f = await fixture(adapter);
      await f.evidence.indexRun(f.input.runId);
      const found = await f.evidence.searchEpisodes({
        allowedThreadIds: [f.threadId],
        query: 'opalword',
      });
      const source = found.matches.find((row) => row.role === 'user')!;
      const job = await f.jobs.enqueue({
        kind: 'dream',
        dotId: f.dot.id,
        sourceIds: found.matches.map((row) => row.id),
        origin: 'manual',
        logicalKey: 'publication',
        publicationPolicy: 'hybrid',
      });
      const claimed = (await f.jobs.claim())!;
      const proposal = {
        changes: [
          {
            kind: 'create' as const,
            title: 'Tea preference',
            text: source.text,
            sourceIds: [source.id],
            sources: [source.source],
            support: 'explicit_user' as const,
            explicitUser: true,
            justification: 'User preference',
            retention: 'stable' as const,
            expiresAt: null,
          },
        ],
        evidence: [source.source],
      };
      const request = {
        jobId: job.id,
        lease: claimed.leaseToken!,
        generation: claimed.attempts,
        proposal,
        policy: 'hybrid' as const,
        dotId: f.dot.id,
      };
      await expect(
        f.jobs.publishDream({ ...request, lease: 'stale' }),
      ).rejects.toThrow(/lease|ownership/i);
      await expect(
        f.jobs.publishDream({ ...request, generation: claimed.attempts + 1 }),
      ).rejects.toThrow(/generation|lease|ownership/i);
      await expect(
        f.jobs.publishDream({ ...request, dotId: 'wrong-dot' }),
      ).rejects.toThrow(/scope|dot/i);
      expect((await f.workspace.memory.listOwner()).items).toEqual([]);
      const receipt = await f.jobs.publishDream(request);
      expect((await f.jobs.publishDream(request)).id).toBe(receipt.id);
      expect((await f.workspace.memory.listOwner()).items).toHaveLength(1);
      expect((await f.jobs.get(job.id))?.state).toBe('succeeded');
      expect(
        await f.evidence.pendingSources({
          dotId: f.dot.id,
          since: 0,
          threadIds: [f.threadId],
          cursor: '',
        }),
      ).toEqual([]);
    });
  });
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'does not acknowledge a legacy publication using an obsolete job lease',
  async () => {
    const { vi } = await import('vitest');
    const f = await fixture('postgres');
    await f.evidence.indexRun(f.input.runId);
    const found = await f.evidence.searchEpisodes({
      allowedThreadIds: [f.threadId],
      query: 'opalword',
    });
    const source = found.matches.find((row) => row.role === 'user')!;
    const job = await f.jobs.enqueue({
      kind: 'dream',
      dotId: f.dot.id,
      sourceIds: found.matches.map((row) => row.id),
      origin: 'manual',
      logicalKey: 'late-ack',
      publicationPolicy: 'hybrid',
    });
    const first = (await f.jobs.claim())!;
    const proposal = {
      changes: [
        {
          kind: 'create' as const,
          title: 'Tea preference',
          text: source.text,
          sourceIds: [source.id],
          sources: [source.source],
          support: 'explicit_user' as const,
          explicitUser: true,
          justification: 'User preference',
          retention: 'stable' as const,
          expiresAt: null,
        },
      ],
      evidence: [source.source],
    };
    // The fixture's legacy repository exposes acknowledge for its receipt-before-ack recovery boundary.
    const jobs = f.jobs as import('../src/server/memory-jobs.js').MemoryJobs;
    const acknowledge = jobs.acknowledge.bind(jobs);
    const spy = vi
      .spyOn(jobs, 'acknowledge')
      .mockImplementationOnce(async (...args) => {
        await jobs.claim(Date.now() + 61_000);
        return acknowledge(...args);
      });
    try {
      await expect(
        jobs.publishDream({
          jobId: job.id,
          lease: first.leaseToken!,
          generation: first.attempts,
          proposal,
          policy: 'hybrid',
          dotId: f.dot.id,
        }),
      ).rejects.toThrow(/lease|ownership/i);
      const second = (await jobs.get(job.id))!;
      expect(second.state).toBe('running');
      expect(second.attempts).toBe(2);
      expect((await f.workspace.memory.listOwner()).items).toHaveLength(1);
      const receipt = await jobs.publishDream({
        jobId: job.id,
        lease: second.leaseToken!,
        generation: second.attempts,
        proposal,
        policy: 'hybrid',
        dotId: f.dot.id,
      });
      expect(receipt.changes).toHaveLength(1);
      expect((await f.workspace.memory.listOwner()).items).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  },
);
it('finishes bounded Unicode indexing before making sources eligible for Dream', async () => {
  const f = await fixture('sqlite');
  const threadId = randomUUID();
  await f.workspace.bindThread(threadId, f.dot.id, 'Long evidence');
  await f.conversations.createThread({
    threadId,
    userId: f.owner,
    agentId: f.dot.id,
  });
  const text = 'opalword 🌿 '.repeat(25_000);
  const messages: Message[] = [
    { id: 'long-user', role: 'user', content: text },
  ];
  const lease = (await f.conversations.acquireThread(threadId))!;
  const runId = randomUUID();
  await lease.beginRun({ ...f.input, threadId, runId, messages }, f.guard);
  await lease.finishRun(messages, {}, 'finished');
  await lease.release();
  expect(
    (
      await f.client!.call('evidence.indexBatch', [runId], {
        priority: 'background',
      })
    ).complete,
  ).toBe(false);
  expect(
    await f.evidence.pendingSources({
      dotId: f.dot.id,
      since: 0,
      threadIds: [threadId],
      cursor: '',
    }),
  ).toEqual([]);
  await f.evidence.indexRun(runId);
  const chunks: import('../src/server/conversation-memory.js').SourceRecord[] =
    [];
  let cursor: string | undefined;
  do {
    const page = await f.evidence.searchEpisodes({
      allowedThreadIds: [threadId],
      query: 'opalword',
      cursor,
    });
    chunks.push(...page.matches);
    cursor = page.nextCursor;
  } while (cursor);
  expect(chunks.length).toBeGreaterThan(64);
  expect(chunks.every((chunk) => Buffer.byteLength(chunk.text) <= 4000)).toBe(
    true,
  );
  expect(
    chunks
      .sort((a, b) => a.source.start! - b.source.start!)
      .map((chunk) => chunk.text)
      .join(''),
  ).toBe(text);
  expect(
    (
      await f.evidence.pendingSources({
        dotId: f.dot.id,
        since: 0,
        threadIds: [threadId],
        cursor: '',
      })
    ).length,
  ).toBeGreaterThan(0);
});
it.each(['before-ack', 'committed'])(
  'recovers atomic SQLite publication after SIGKILL at %s',
  async (mode) => {
    const { fork } = await import('node:child_process');
    const { once } = await import('node:events');
    const { fileURLToPath } = await import('node:url');
    const { join } = await import('node:path');
    const { readFile, writeFile } = await import('node:fs/promises');
    const { DatabaseSync } = await import('node:sqlite');
    const { StorageClient } =
      await import('../src/server/storage/storage-client.js');
    const { vi } = await import('vitest');
    const f = await fixture('sqlite');
    await f.evidence.indexRun(f.input.runId);
    const sources = (
      await f.evidence.searchEpisodes({
        allowedThreadIds: [f.threadId],
        query: 'opalword',
      })
    ).matches;
    const source = sources.find((row) => row.role === 'user')!;
    const job = await f.jobs.enqueue({
      kind: 'dream',
      dotId: f.dot.id,
      sourceIds: sources.map((row) => row.id),
      origin: 'manual',
      logicalKey: 'crash-publication',
      publicationPolicy: 'hybrid',
    });
    const claimed = (await f.jobs.claim())!;
    const request = {
      jobId: job.id,
      lease: claimed.leaseToken!,
      generation: claimed.attempts,
      dotId: f.dot.id,
      policy: 'hybrid' as const,
      proposal: {
        changes: [
          {
            kind: 'create' as const,
            title: 'Tea preference',
            text: source.text,
            sourceIds: [source.id],
            sources: [source.source],
            support: 'explicit_user' as const,
            explicitUser: true,
            justification: 'Preference',
            retention: 'stable' as const,
            expiresAt: null,
          },
        ],
        evidence: [source.source],
      },
    };
    const requestFile = join(f.root, 'publication.json');
    await writeFile(requestFile, JSON.stringify(request));
    await f.conversations.close();
    await f.client!.close();
    const child = fork(
      fileURLToPath(
        new URL('./fixtures/memory-publication-crash.ts', import.meta.url),
      ),
      [f.database, f.owner, requestFile, mode],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    const exited = once(child, 'exit');
    cleanups.push(async () => {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
      await exited;
    });
    expect((await once(child, 'message'))[0]).toBe(
      mode === 'committed' ? 'committed' : 'publishing',
    );
    if (mode === 'before-ack') {
      await vi.waitFor(async () =>
        expect(await readFile(f.database + '.started', 'utf8')).toBe('started'),
      );
      const observer = new DatabaseSync(f.database, { readOnly: true });
      try {
        expect(
          Number(
            observer.prepare('SELECT count(*) AS n FROM memory_items').get()!.n,
          ),
        ).toBe(0);
        expect(
          Number(
            observer.prepare('SELECT count(*) AS n FROM memory_receipts').get()!
              .n,
          ),
        ).toBe(0);
      } finally {
        observer.close();
      }
    }
    child.kill('SIGKILL');
    await exited;
    const resumed = await StorageClient.open({
      database: f.database,
      ownerId: f.owner,
    });
    cleanups.push(() => resumed.close());
    if (mode === 'before-ack') {
      expect(
        (await resumed.repositories.workspace.memory.listOwner()).items,
      ).toEqual([]);
      const next = (await resumed.repositories.jobs.claim(
        Date.now() + 61_000,
      ))!;
      request.lease = next.leaseToken!;
      request.generation = next.attempts;
    }
    const receipt = await resumed.repositories.jobs.publishDream(request);
    expect((await resumed.repositories.jobs.publishDream(request)).id).toBe(
      receipt.id,
    );
    expect(
      (await resumed.repositories.workspace.memory.listOwner()).items,
    ).toHaveLength(1);
    expect((await resumed.repositories.jobs.get(job.id))?.state).toBe(
      'succeeded',
    );
    expect(
      await resumed.repositories.evidence.pendingSources({
        dotId: f.dot.id,
        since: 0,
        threadIds: [f.threadId],
        cursor: '',
      }),
    ).toEqual([]);
  },
);

async function publicationFixture(adapter: 'postgres' | 'sqlite', entry?: URL) {
  const f = await fixture(adapter, entry);
  await f.evidence.indexRun(f.input.runId);
  const sources = (
    await f.evidence.searchEpisodes({
      allowedThreadIds: [f.threadId],
      query: 'opalword',
    })
  ).matches;
  const source = sources.find((row) => row.role === 'user')!;
  const job = await f.jobs.enqueue({
    kind: 'dream',
    dotId: f.dot.id,
    sourceIds: sources.map((row) => row.id),
    origin: 'manual',
    logicalKey: 'fenced-publication',
    publicationPolicy: 'hybrid',
  });
  const claimed = (await f.jobs.claim())!;
  const request: import('../src/server/memory-jobs.js').PublishDreamInput = {
    jobId: job.id,
    lease: claimed.leaseToken!,
    generation: claimed.attempts,
    dotId: f.dot.id,
    policy: 'hybrid',
    proposal: {
      changes: [
        {
          kind: 'create',
          title: 'Tea preference',
          text: source.text,
          sourceIds: [source.id],
          sources: [source.source],
          support: 'explicit_user',
          explicitUser: true,
          justification: 'User preference',
          retention: 'stable',
          expiresAt: null,
        },
      ],
      evidence: [source.source],
    },
  };
  return { ...f, request, job, source };
}
it('retries a busy atomic publication while allowing foreground reads', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const f = await publicationFixture('sqlite');
  const lock = new DatabaseSync(f.database);
  let settled = false;
  lock.exec('BEGIN IMMEDIATE');
  try {
    const pending = f.jobs
      .publishDream(f.request)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    expect(await f.store.settings()).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    lock.exec('COMMIT');
    const result = await pending;
    expect(result).toHaveProperty('value.jobId', f.job.id);
    expect((await f.workspace.memory.listOwner()).items).toHaveLength(1);
  } finally {
    if (lock.isTransaction) lock.exec('ROLLBACK');
    lock.close();
  }
});
it('rolls back cancelled publication at the acknowledgment boundary', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { vi } = await import('vitest');
  const f = await publicationFixture(
    'sqlite',
    new URL('./fixtures/repository-worker-probe.ts', import.meta.url),
  );
  const controller = new AbortController();
  const pending = f.client!.call('jobs.publishDream', [f.request], {
    signal: controller.signal,
  });
  const checked = expect(pending).rejects.toThrow(/cancel|abort/i);
  await vi.waitFor(async () =>
    expect(await readFile(f.database + '.started', 'utf8')).toBe('started'),
  );
  controller.abort();
  await writeFile(f.database + '.continue', 'continue');
  await checked;
  expect((await f.workspace.memory.listOwner()).items).toEqual([]);
  expect(await f.workspace.memory.history.receipt(f.job.id)).toBeUndefined();
  expect((await f.jobs.get(f.job.id))?.state).toBe('running');
  await f.jobs.publishDream(f.request);
  expect((await f.workspace.memory.listOwner()).items).toHaveLength(1);
});
for (const adapter of ['postgres', 'sqlite'] as const)
  describe.skipIf(
    adapter === 'postgres' && !process.env.LOCAL_TEST_DATABASE_URL,
  )(adapter + ' publication fences', () => {
    it.each([
      'missing',
      'suppressed',
      'revoked',
      'cancelled',
      'expired',
    ] as const)(
      'rejects %s evidence or ownership without partial memory writes',
      async (mode) => {
        const f = await publicationFixture(adapter);
        if (mode === 'missing')
          f.request.proposal.changes[0].sources[0].contentHash = 'f'.repeat(64);
        if (mode === 'suppressed')
          await f.workspace.memory.history.suppress(
            [f.source.source],
            'forgotten',
          );
        if (mode === 'revoked') {
          const space = await f.workspace.createSpace(
            'Other',
            'Revoked original access',
          );
          await f.workspace.updateDot(f.dot.id, {
            ...f.dot,
            spaceId: space.id,
            spaceIds: [space.id],
          });
        }
        if (mode === 'cancelled') await f.jobs.cancelQueued(f.dot.id, 'dream');
        if (mode === 'expired') await expireJob(f, adapter);
        await expect(f.jobs.publishDream(f.request)).rejects.toThrow(
          /evidence|suppressed|revoked|lease|access/i,
        );
        expect((await f.workspace.memory.listOwner()).items).toEqual([]);
        expect(
          await f.workspace.memory.history.receipt(f.job.id),
        ).toBeUndefined();
      },
    );
    it('rejects invalid automatic limits before admitting any job', async () => {
      const f = await fixture(adapter);
      const job = await f.jobs.enqueue({
        kind: 'dream',
        dotId: f.dot.id,
        sourceIds: [],
        origin: 'automatic',
        logicalKey: 'invalid-limit',
      });
      await expect(
        f.jobs.admitAutomatic(job.id, '2026-10-20', 0),
      ).rejects.toThrow(/limit/i);
      expect(await f.jobs.claim()).toBeUndefined();
    });
    it('uses current time when checking a checkpoint job lease', async () => {
      const f = await publicationFixture(adapter);
      await expireJob(f, adapter);
      const checkpoint: ContextCheckpoint = {
        id: randomUUID(),
        threadId: f.threadId,
        schemaVersion: 1,
        sourceMessageIds: ['user'],
        sourceHash: evidenceHash([f.messages[0]]),
        permissionGeneration: 'fixture',
        suppressionGeneration: 0,
        goal: 'Tea preference',
        constraints: [],
        decisions: [],
        completedWork: [],
        openQuestions: [],
        nextSteps: [],
        evidenceMessageIds: ['user'],
        createdAt: Date.now(),
      };
      expect(
        await f.evidence.saveCheckpoint(checkpoint, checkpoint.sourceHash, {
          id: f.job.id,
          token: f.request.lease,
          now: 1,
        }),
      ).toBe(false);
      expect(await f.evidence.latestCheckpoint(f.threadId)).toBeUndefined();
    });
  });
async function expireJob(
  f: Awaited<ReturnType<typeof publicationFixture>>,
  adapter: 'postgres' | 'sqlite',
) {
  if (adapter === 'postgres')
    await (
      f.jobs as import('../src/server/memory-jobs.js').MemoryJobs
    ).pg.query(
      'UPDATE memory_jobs SET lease_until=$1 WHERE owner_id=$2 AND id=$3',
      [Date.now() - 1, f.owner, f.job.id],
    );
  else {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(f.database);
    try {
      db.prepare(
        'UPDATE memory_jobs SET lease_until=? WHERE owner_id=? AND id=?',
      ).run(Date.now() - 1, f.owner, f.job.id);
    } finally {
      db.close();
    }
  }
}
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'uses legacy PostgreSQL evidence from the storage worker without creating unified tables',
  async () => {
    const f = await fixture('postgres');
    const { StorageClient } =
      await import('../src/server/storage/storage-client.js');
    const pg = (f.jobs as import('../src/server/memory-jobs.js').MemoryJobs).pg;
    const storage = await StorageClient.open({
      database: f.database,
      ownerId: f.owner,
      engine: 'legacy-postgres',
      postgresUrl: pg.options.connectionString,
    });
    cleanups.push(() => storage.close());
    await storage.repositories.evidence.indexRun(f.input.runId);
    expect(
      (
        await storage.repositories.recall.search(f.dot.id, {
          query: 'opalword',
          kinds: ['episode'],
        })
      ).matches,
    ).toHaveLength(2);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(f.database, { readOnly: true });
    try {
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name='conversation_threads'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  },
);
