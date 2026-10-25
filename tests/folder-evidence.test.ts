import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@ag-ui/core';
import { afterEach, expect, it } from 'vitest';
import { folderTools } from '../src/server/folder-tools.js';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { SQLiteConversations } from '../src/server/storage/sqlite-conversations.js';
import type { EvidenceGuard } from '../src/shared/memory.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dots-folder-evidence-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const storage = await StorageClient.open({
    database: join(root, 'test.sqlite'),
    ownerId: 'evidence-owner',
  });
  cleanups.push(() => storage.close());
  const { workspace, voiceDelegations: jobs } = storage.repositories;
  const dot = (await workspace.dots())[0];
  const conversations = new SQLiteConversations(storage);
  cleanups.push(() => conversations.close());
  const guard = { originDotId: dot.id, spaceIds: [], pageIds: [] };
  const begin = async (threadId: string, inherited: EvidenceGuard = guard) => {
    if (threadId !== 'task')
      await workspace.bindThread(threadId, dot.id, 'Folder task');
    await conversations.getOrCreateThread({
      threadId,
      agentId: dot.id,
      userId: 'evidence-owner',
    });
    const lease = (await conversations.acquireThread(threadId))!;
    await lease.beginRun(
      {
        threadId,
        runId: randomUUID(),
        messages: [],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      },
      inherited,
    );
    return lease;
  };
  await workspace.bindThread('task', dot.id, 'Folder task');
  const approve = async (access: 'read' | 'readwrite') => {
    const request = await workspace.folders.request(dot.id, 'task', {
      folderHint: root,
      reason: 'Read fixture',
      access,
    });
    const selection = await workspace.folders.select('task', request.id, root);
    const decision = await workspace.folders.decide('task', request.id, {
      toolCallId: randomUUID(),
      selectionId: selection.id,
      approve: true,
      access,
    });
    return decision.grantId!;
  };
  const tools = (record?: (guard: EvidenceGuard) => Promise<void>) =>
    folderTools(
      workspace.folders,
      dot.id,
      'task',
      () => {},
      new AbortController().signal,
      undefined,
      'task',
      record,
    );
  const answer: Message = {
    id: 'answer',
    role: 'assistant',
    content: 'The project label is amber fox.',
  };
  await writeFile(join(root, 'notes.txt'), 'amber fox');
  return { root, workspace, jobs, dot, guard, begin, approve, tools, answer };
}

it.each(['read', 'readwrite'] as const)(
  'persists actual file evidence and denies direct and inherited prose after %s revocation',
  async (access) => {
    const f = await fixture();
    const first = await f.approve(access);
    const second = await f.approve(access);
    const lease = await f.begin('task');
    const tools = f.tools((guard) => lease.addEvidenceGuard!(guard));
    for (const grantId of [first, second]) {
      expect(
        await tools.find((tool) => tool.name === 'read_local_file')!.execute!({
          grantId,
          path: 'notes.txt',
        } as never),
      ).toMatchObject({ content: 'amber fox' });
    }
    await lease.finishRun([f.answer], {}, 'finished');
    await lease.release();
    const context = await f.jobs.threadContext('task', f.dot.id);
    expect(context).toMatchObject({
      available: true,
      guard: { folderGrantIds: [first, second].sort() },
    });
    expect(
      await f.workspace.folders.executionScope(f.dot.id, 'task'),
    ).toBeUndefined();
    const inherited = await f.begin('followup', context.guard);
    await inherited.finishRun(
      [{ ...f.answer, id: 'followup-answer' }],
      {},
      'finished',
    );
    await inherited.release();
    expect((await f.jobs.threadContext('followup', f.dot.id)).available).toBe(
      true,
    );
    await f.workspace.folders.revoke(f.dot.id, first);
    for (const threadId of ['task', 'followup']) {
      expect(await f.jobs.threadContext(threadId, f.dot.id)).toMatchObject({
        available: false,
        messages: [],
      });
    }
  },
);

it.each(['list_local_folder', 'read_local_file', 'write_local_file'] as const)(
  'recovers legacy grant dependencies from canonical %s call/result pairs',
  async (name) => {
    const f = await fixture();
    const grantId = await f.approve(
      name === 'write_local_file' ? 'readwrite' : 'read',
    );
    const args = {
      grantId,
      path:
        name === 'list_local_folder'
          ? '.'
          : name === 'write_local_file'
            ? 'new.txt'
            : 'notes.txt',
      ...(name === 'write_local_file'
        ? { content: 'new content', expectedHash: 'new' }
        : {}),
    };
    const result = await f.tools().find((tool) => tool.name === name)!.execute!(
      args as never,
    );
    const messages: Message[] = [
      {
        id: 'call',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'file-call',
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      {
        id: 'result',
        role: 'tool',
        toolCallId: 'file-call',
        content: JSON.stringify(result),
      },
      f.answer,
    ];
    const lease = await f.begin('task');
    await lease.finishRun(messages, {}, 'finished');
    await lease.release();
    expect(await f.jobs.threadContext('task', f.dot.id)).toMatchObject({
      available: true,
      hasToolActivity: true,
      guard: { folderGrantIds: [grantId] },
    });
    await f.workspace.folders.revoke(f.dot.id, grantId);
    expect(await f.jobs.threadContext('task', f.dot.id)).toMatchObject({
      available: false,
      messages: [],
    });
  },
);

it.each(['{"path":"notes.txt"}', '{', '{"grantId":"invented"}'])(
  'withholds malformed legacy folder provenance (%s)',
  async (args) => {
    const f = await fixture();
    const lease = await f.begin('task');
    await lease.finishRun(
      [
        {
          id: 'call',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'file-call',
              type: 'function',
              function: { name: 'read_local_file', arguments: args },
            },
          ],
        },
        {
          id: 'result',
          role: 'tool',
          toolCallId: 'file-call',
          content: '{"error":"Denied"}',
        },
        f.answer,
      ],
      {},
      'finished',
    );
    await lease.release();
    expect(await f.jobs.threadContext('task', f.dot.id)).toMatchObject({
      available: false,
      messages: [],
    });
  },
);

it('withholds file content when its evidence cannot be persisted', async () => {
  const f = await fixture();
  const grantId = await f.approve('read');
  const tools = f.tools(async () => {
    throw new Error('Evidence persistence failed');
  });
  await expect(
    tools.find((tool) => tool.name === 'read_local_file')!.execute!({
      grantId,
      path: 'notes.txt',
    } as never),
  ).rejects.toThrow('Evidence persistence failed');
});

it('withholds file content revoked while its evidence is being persisted', async () => {
  const f = await fixture();
  const grantId = await f.approve('read');
  const tools = f.tools(async () => {
    await f.workspace.folders.revoke(f.dot.id, grantId);
  });
  await expect(
    tools.find((tool) => tool.name === 'read_local_file')!.execute!({
      grantId,
      path: 'notes.txt',
    } as never),
  ).rejects.toThrow(/revoked/);
});
