import { SQLiteConversations } from '../../src/server/storage/sqlite-conversations.js';
import { StorageClient } from '../../src/server/storage/storage-client.js';
import { EventType } from '@ag-ui/core';
const [database, owner, mode] = process.argv.slice(2);
const client = await StorageClient.open({
  database,
  ownerId: owner,
  ...(mode === 'inflight'
    ? { entry: new URL('./repository-worker-probe.ts', import.meta.url) }
    : {}),
});
const store = new SQLiteConversations(client, { leaseMs: 250 });
await store.createThread({
  threadId: 'crash-thread',
  userId: owner,
  agentId: 'dot',
});
const lease = (await store.acquireThread('crash-thread'))!;
await lease.beginRun({
  threadId: 'crash-thread',
  runId: 'crash-run',
  messages: [{ id: 'user', role: 'user', content: 'Saved input' }],
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
});
await lease.appendEvent({
  type: EventType.RUN_STARTED,
  threadId: 'crash-thread',
  runId: 'crash-run',
});
await lease.appendEvent({
  type: EventType.TEXT_MESSAGE_START,
  messageId: 'answer',
  role: 'assistant',
});
await lease.appendEvent({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: 'answer',
  delta: 'Committed output',
});
process.send?.('ready');
setInterval(() => undefined, 1000);
