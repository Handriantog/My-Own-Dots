// Run with node --import tsx. Uses only a dedicated disposable test database.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { WorkspaceStore } from '../src/server/workspace.ts';
import { Store } from '../src/server/store.ts';
import { PostgresConversations } from '../src/server/local-conversations.ts';
import { MemoryMaintenance } from '../src/server/memory-maintenance.ts';
import { MemoryRecall } from '../src/server/memory-recall.ts';
import { ContextBuilder } from '../src/server/context-builder.ts';
import { MemoryMetrics, memoryMetrics } from '../src/server/memory-metrics.ts';
const url = process.env.LOCAL_TEST_DATABASE_URL;
const identity = (value) => {
  const parsed = new URL(value);
  return `${parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
};
if (
  !url ||
  !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)) ||
  (process.env.LOCAL_DATABASE_URL &&
    identity(url) === identity(process.env.LOCAL_DATABASE_URL))
)
  throw new Error(
    'Set a dedicated LOCAL_TEST_DATABASE_URL containing test in its database name; production databases are refused.',
  );
const directory = await mkdtemp(join(tmpdir(), 'dots-memory-benchmark-')),
  owner = 'benchmark-' + randomUUID(),
  pg = new Pool({ connectionString: url });
const workspace = new WorkspaceStore(
    join(directory, 'workspace.sqlite'),
    owner,
  ),
  store = new Store(join(directory, 'app.sqlite')),
  conversations = new PostgresConversations(url, owner);
const memory = new MemoryMaintenance(
  store,
  workspace,
  { localDatabaseUrl: url, llmProvider: 'claude-code' },
  {
    pg,
    invoke: async () => ({
      result: {
        goal: 'Benchmark current task',
        constraints: [],
        decisions: [],
        completedWork: [],
        openQuestions: [],
        nextSteps: [],
        evidenceMessageIds: [],
      },
      usage: {},
    }),
  },
);
const dot = workspace.dots()[0],
  measurements = new MemoryMetrics(1000);
const measure = async (stage, cold, fn) => {
  const start = performance.now();
  await fn();
  measurements.observe(stage, performance.now() - start, cold);
};
try {
  await conversations.initialize();
  workspace.memory.atomic(() => {
    for (let i = 0; i < 10000; i++)
      workspace.memory.create({
        scope: { kind: 'dot', id: dot.id },
        title: `Reference ${i}`,
        text: `Project identifier REF${i} has approved value ${i}.`,
        pinned: i === 0,
      });
  });
  for (let t = 0; t < 100; t++) {
    const id = 'thread-' + t,
      runId = 'run-' + t;
    workspace.bindThread(id, dot.id, 'Benchmark');
    await conversations.getOrCreateThread({
      threadId: id,
      userId: owner,
      agentId: dot.id,
    });
    const messages = Array.from({ length: 1000 }, (_, i) => ({
      id: `m${t}-${i}`,
      role: i % 2 ? 'assistant' : 'user',
      content: `Archive item ARCHIVE${t * 1000 + i} has value ${i}.`,
    }));
    const lease = await conversations.acquireThread(id);
    await lease.beginRun(
      {
        threadId: id,
        runId,
        messages,
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      },
      { originDotId: dot.id, spaceIds: [], pageIds: [] },
    );
    await lease.finishRun(messages, {}, 'finished');
    await lease.release();
    await memory.repository.indexRun(runId);
  }
  const frame = {
    ownerId: owner,
    dotId: dot.id,
    threadId: 'thread-0',
    runId: 'benchmark',
    canonicalMessages: await memory.repository.threadMessages('thread-0'),
  };
  for (let i = 0; i < 20; i++) {
    if (
      (await memory.compaction.compact(
        'thread-0',
        new AbortController().signal,
      )) === 'no_change'
    )
      break;
  }
  const payload = {
    systemPrompts: ['Help with the current task.'],
    messages: frame.canonicalMessages,
    availableTools: [],
  };
  for (let i = 0; i < 30; i++) {
    const recall = new MemoryRecall(
      workspace.memory,
      memory.repository,
      memory.recall.access,
    );
    await measure('recall', true, () =>
      recall.search(dot.id, { query: 'REF' + i * 311 }),
    );
    await measure('recall', false, () =>
      recall.search(dot.id, { query: 'REF' + i * 311 }),
    );
    const context = new ContextBuilder(recall, {}, memory.compaction);
    await measure('context', true, () =>
      context.project(payload, frame, new AbortController().signal),
    );
    await measure('context', false, () =>
      context.project(payload, frame, new AbortController().signal),
    );
  }
  const broadStart = performance.now();
  await memory.recall.search(dot.id, {
    query: 'Archive item',
    kinds: ['episode'],
  });
  const broadEpisodeMs = performance.now() - broadStart;
  console.log(
    JSON.stringify(
      {
        environment: {
          node: process.version,
          os: osPlatform(),
          cpu: cpus()[0]?.model,
        },
        dataset: {
          memories: 10000,
          messages: 100000,
          threads: 100,
          activeThreadMessages: 1000,
        },
        cacheDefinition:
          'cold=new service cache, warm=repeated query; database and OS caches are not flushed',
        targetsMs: { recallP95: 100, contextP95: 200 },
        measurements: measurements.snapshot(),
        broadEpisodeMs,
        stageTimings: memoryMetrics.snapshot(),
        provider:
          'deterministic in-process fixture; live provider timing measured separately',
      },
      null,
      2,
    ),
  );
} finally {
  await memory.stop();
  for (const table of [
    'memory_processed_sources',
    'memory_daily_admissions',
    'memory_jobs',
    'local_ai_runs',
    'local_ai_threads',
    'memory_index_meta',
  ])
    await pg.query(`DELETE FROM ${table} WHERE owner_id=$1`, [owner]);
  await conversations.close();
  await pg.end();
  workspace.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
