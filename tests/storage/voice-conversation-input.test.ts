import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../../src/server/store.js';
import { WorkspaceStore } from '../../src/server/workspace.js';
import { initializeSQLiteSchema } from '../../src/server/storage/sqlite-schema.js';
import { StorageClient } from '../../src/server/storage/storage-client.js';
import { SQLiteConversations } from '../../src/server/storage/sqlite-conversations.js';
import {
  copyValidatedSQLite,
  restoreSQLite,
} from '../../src/server/storage/restore-sqlite.js';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function schemaSeven() {
  const root = await mkdtemp(join(tmpdir(), 'dots-voice-conversation-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'workspace.sqlite');
  const owner = randomUUID();
  const db = new DatabaseSync(path);
  cleanups.push(() => {
    if (db.isOpen) db.close();
  });
  db.exec('PRAGMA foreign_keys=ON');
  new Store(':memory:', db);
  const workspace = new WorkspaceStore(':memory:', owner, db);
  initializeSQLiteSchema(db, 7);
  const dot = workspace.dots()[0];
  db.prepare(
    'INSERT INTO conversation_threads(owner_id,id,agent_id,created_at,updated_at) VALUES(?,?,?,?,?)',
  ).run(owner, 'parent', dot.id, 1, 1);
  workspace.bindThread('parent', dot.id, 'Conversation');
  const call = workspace.createCall('parent');
  return { root, path, db, owner, dotId: dot.id, callId: call.id };
}
function insert(
  f: Awaited<ReturnType<typeof schemaSeven>>,
  id: string,
  kind: string,
  rowid: number,
  deliveredAt: number | null = null,
) {
  f.db
    .prepare(
      'INSERT INTO voice_input_receipts(rowid,ownerId,id,dotId,callId,parentThreadId,caption,kind,reply,status,createdAt,deliveredAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      rowid,
      f.owner,
      id,
      f.dotId,
      f.callId,
      'parent',
      'Hello Dot',
      kind,
      'Hello.',
      'received',
      100,
      deliveredAt,
    );
}

it('upgrades schema 7 atomically while preserving receipt data, row ordering, indexes and foreign keys', async () => {
  const f = await schemaSeven();
  insert(f, 'later', 'request', 41);
  insert(f, 'earlier', 'status', 3);
  insert(f, 'delivered', 'stop', 90, 123);
  f.db.exec(
    'CREATE INDEX receipt_delivery_lookup ON voice_input_receipts(ownerId,deliveredAt,createdAt)',
  );
  const rows = f.db
    .prepare(
      'SELECT rowid,* FROM voice_input_receipts ORDER BY createdAt,rowid',
    )
    .all();
  const foreignKeys = f.db
    .prepare('PRAGMA foreign_key_list(voice_input_receipts)')
    .all();
  const indexes = f.db.prepare('PRAGMA index_list(voice_input_receipts)').all();
  initializeSQLiteSchema(f.db);
  expect(
    f.db
      .prepare('SELECT max(version) AS version FROM workspace_storage_schema')
      .get()!.version,
  ).toBe(9);
  expect(
    f.db
      .prepare(
        'SELECT rowid,* FROM voice_input_receipts ORDER BY createdAt,rowid',
      )
      .all(),
  ).toEqual(rows.map((row) => ({ ...row, replySuppressionGeneration: null })));
  expect(
    f.db.prepare('PRAGMA foreign_key_list(voice_input_receipts)').all(),
  ).toEqual(foreignKeys);
  expect(f.db.prepare('PRAGMA index_list(voice_input_receipts)').all()).toEqual(
    indexes,
  );
  insert(f, 'conversation', 'conversation', 100);
  expect(() => insert(f, 'unknown', 'unsupported', 101)).toThrow(/CHECK/);
  expect(() => insert(f, 'conversation', 'conversation', 102)).toThrow(
    /UNIQUE/,
  );
  expect(() =>
    f.db
      .prepare(
        "UPDATE voice_input_receipts SET callId='missing' WHERE id='conversation'",
      )
      .run(),
  ).toThrow(/FOREIGN KEY/);
  expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  initializeSQLiteSchema(f.db);
  expect(
    f.db.prepare('SELECT count(*) AS n FROM voice_input_receipts').get()!.n,
  ).toBe(4);
});

it('rolls back the schema-8 rebuild if an old receipt violates the replacement constraint', async () => {
  const f = await schemaSeven();
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  insert(f, 'invalid', 'unsupported', 77);
  f.db.exec('PRAGMA ignore_check_constraints=OFF');
  expect(() => initializeSQLiteSchema(f.db)).toThrow(/CHECK/);
  expect(
    f.db
      .prepare('SELECT max(version) AS version FROM workspace_storage_schema')
      .get()!.version,
  ).toBe(7);
  expect(
    f.db.prepare('SELECT rowid,id,kind FROM voice_input_receipts').get(),
  ).toEqual({ rowid: 77, id: 'invalid', kind: 'unsupported' });
  expect(
    f.db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name='voice_input_receipts_v8'",
      )
      .get(),
  ).toBeUndefined();
});

async function workerFixture() {
  const f = await schemaSeven();
  f.db.close();
  const storage = await StorageClient.open({
    database: f.path,
    ownerId: f.owner,
    engine: 'sqlite',
  });
  cleanups.push(() => storage.close());
  const jobs = storage.repositories.voiceDelegations;
  const input = {
    id: 'hello',
    dotId: f.dotId,
    callId: f.callId,
    parentThreadId: 'parent',
    caption: 'Hello Dot',
    kind: 'conversation' as const,
    reply: 'Hello.',
  };
  return { ...f, storage, jobs, input };
}

it('persists effect-free conversation input through the real worker outside the task queue', async () => {
  const f = await workerFixture();
  for (let i = 0; i < 16; i++)
    await f.jobs.receiveInput({ ...f.input, id: `task-${i}`, kind: 'request' });
  await expect(
    f.jobs.receiveInput({ ...f.input, id: 'overflow', kind: 'request' }),
  ).rejects.toThrow(/queue is full/);
  const result = await f.jobs.receiveInput({
    ...f.input,
    reply: 'x'.repeat(400),
  });
  expect(result).toMatchObject({
    created: true,
    receipt: {
      kind: 'conversation',
      reply: 'x'.repeat(400),
      status: 'received',
    },
  });
  expect(await f.jobs.receiveInput(f.input)).toMatchObject({
    created: false,
    receipt: { reply: 'x'.repeat(400) },
  });
  await expect(
    f.jobs.receiveInput({ ...f.input, id: 'too-long', reply: 'x'.repeat(401) }),
  ).rejects.toThrow(/Invalid voice input/);
  await expect(
    f.jobs.receiveInput({ ...f.input, kind: 'request' }),
  ).rejects.toThrow(/identity/);
  expect(await f.jobs.list()).toEqual([]);
  expect(
    (await f.jobs.pendingInputs()).find((row) => row.id === f.input.id),
  ).toMatchObject({ kind: 'conversation' });
});

it('retrieves delivered input by ID through the owner-scoped storage RPC', async () => {
  const f = await workerFixture();
  expect(typeof f.jobs.inputReceipt).toBe('function');
  expect(await f.jobs.inputReceipt('missing')).toBeUndefined();
  await f.jobs.receiveInput(f.input);
  await f.jobs.deliverInput(f.input.id);
  expect(await f.jobs.pendingInputs()).toEqual([]);
  expect(await f.jobs.inputReceipt(f.input.id)).toMatchObject({
    ...f.input,
    deliveredAt: expect.any(Number),
  });
  const other = await StorageClient.open({
    database: f.path,
    ownerId: randomUUID(),
    engine: 'sqlite',
  });
  cleanups.push(() => other.close());
  expect(
    await other.repositories.voiceDelegations.inputReceipt(f.input.id),
  ).toBeUndefined();
});

it('preserves a completed conversation decision across storage-worker restart while interrupting action requests', async () => {
  const f = await workerFixture();
  const saved = await f.jobs.receiveInput({
    ...f.input,
    replySuppressionGeneration: 7,
  });
  await f.jobs.receiveInput({ ...f.input, id: 'action', kind: 'request' });
  await f.storage.close();
  const reopened = await StorageClient.open({
    database: f.path,
    ownerId: f.owner,
    engine: 'sqlite',
  });
  cleanups.push(() => reopened.close());
  const jobs = reopened.repositories.voiceDelegations;
  await jobs.recover();
  await jobs.recover();
  expect(await jobs.inputReceipt(f.input.id)).toEqual(saved.receipt);
  expect(await jobs.inputReceipt('action')).toMatchObject({
    kind: 'request',
    status: 'interrupted',
    reply: 'Interrupted by restart; review chat before asking again.',
  });
  expect(await jobs.list()).toEqual([]);
  await jobs.deliverInput(f.input.id);
  await jobs.recover();
  expect(await jobs.inputReceipt(f.input.id)).toMatchObject({
    ...f.input,
    replySuppressionGeneration: 7,
    deliveredAt: expect.any(Number),
  });
});

it('preserves the acceptance suppression generation through worker storage and duplicate delivery', async () => {
  const f = await workerFixture();
  await f.jobs.receiveInput({ ...f.input, replySuppressionGeneration: 7 });
  expect(await f.jobs.inputReceipt(f.input.id)).toMatchObject({
    replySuppressionGeneration: 7,
  });
  expect(await f.jobs.pendingInputs()).toEqual([
    expect.objectContaining({ replySuppressionGeneration: 7 }),
  ]);
  expect(
    await f.jobs.receiveInput({ ...f.input, replySuppressionGeneration: 8 }),
  ).toMatchObject({
    created: false,
    receipt: { replySuppressionGeneration: 7 },
  });
  await f.jobs.deliverInput(f.input.id);
  expect(await f.jobs.inputReceipt(f.input.id)).toMatchObject({
    replySuppressionGeneration: 7,
    deliveredAt: expect.any(Number),
  });
});

it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects invalid acceptance suppression generation %s',
  async (replySuppressionGeneration) => {
    const f = await workerFixture();
    await expect(
      f.jobs.receiveInput({ ...f.input, replySuppressionGeneration }),
    ).rejects.toThrow(/Invalid voice input/);
    expect(await f.jobs.pendingInputs()).toEqual([]);
  },
);

it('keeps legacy non-contextual receipts without an acceptance suppression generation', async () => {
  const f = await workerFixture();
  await f.jobs.receiveInput(f.input);
  expect(await f.jobs.inputReceipt(f.input.id)).toMatchObject({
    replySuppressionGeneration: null,
  });
});

it.each(['conversation', 'status', 'stop'] as const)(
  'never converts a %s receipt into a task',
  async (kind) => {
    const f = await workerFixture();
    const conversations = new SQLiteConversations(f.storage);
    const lease = (await conversations.acquireThread('parent'))!;
    const messages = [
      { id: 'source', role: 'user' as const, content: f.input.caption },
    ];
    await lease.beginRun({
      threadId: 'parent',
      runId: 'source-run',
      messages,
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    });
    await lease.finishRun(messages, {}, 'finished');
    await lease.release();
    await f.jobs.receiveInput({ ...f.input, kind });
    await expect(
      f.jobs.enqueue(
        {
          id: 'job',
          dotId: f.dotId,
          callId: f.callId,
          parentThreadId: 'parent',
          workerThreadId: 'worker',
          utteranceId: f.input.id,
          sourceMessageId: 'source',
          sourceText: f.input.caption,
          request: 'Run an action',
        },
        true,
      ),
    ).rejects.toThrow(/not a task request/);
    expect(await f.jobs.list()).toEqual([]);
    await expect(
      f.storage.repositories.workspace.requireThread('worker'),
    ).rejects.toThrow();
  },
);

it.each([7, 8] as const)(
  'accepts schema-%s input backups and restores them into schema 9 without replaying input',
  async (schema) => {
    const f = await schemaSeven();
    if (schema === 8) initializeSQLiteSchema(f.db, 8);
    insert(f, 'pending', schema === 8 ? 'conversation' : 'request', 44);
    f.db.close();
    const copied = join(f.root, 'copied.sqlite');
    await copyValidatedSQLite(
      f.path,
      copied,
      f.owner,
      new AbortController().signal,
      'sqlite',
      schema,
    );
    const destination = join(f.root, 'restored');
    await mkdir(join(destination, 'data'), { recursive: true });
    await mkdir(join(destination, 'recovery'));
    const target = join(destination, 'data/workspace.sqlite');
    await restoreSQLite(
      copied,
      target,
      f.owner,
      new AbortController().signal,
      'sqlite',
      schema,
    );
    const restored = new DatabaseSync(target, { readOnly: true });
    try {
      expect(
        restored
          .prepare(
            'SELECT max(version) AS version FROM workspace_storage_schema',
          )
          .get()!.version,
      ).toBe(9);
      expect(
        restored
          .prepare('SELECT rowid,id,status FROM voice_input_receipts')
          .get(),
      ).toEqual({ rowid: 44, id: 'pending', status: 'interrupted' });
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      restored.close();
    }
    const original = new DatabaseSync(f.path, { readOnly: true });
    try {
      expect(
        original
          .prepare(
            'SELECT max(version) AS version FROM workspace_storage_schema',
          )
          .get()!.version,
      ).toBe(schema);
      expect(
        original.prepare('SELECT status FROM voice_input_receipts').get()!
          .status,
      ).toBe('received');
    } finally {
      original.close();
    }
  },
);
