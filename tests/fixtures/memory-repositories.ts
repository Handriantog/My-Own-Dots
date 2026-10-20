import { DreamPublication } from '../../src/server/dream-publication.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Store } from '../../src/server/store.js';
import { WorkspaceStore } from '../../src/server/workspace.js';
import { PostgresConversations } from '../../src/server/local-conversations.js';
import { ConversationMemory } from '../../src/server/conversation-memory.js';
import { MemoryJobs } from '../../src/server/memory-jobs.js';
import { MemoryRecall } from '../../src/server/memory-recall.js';
import { MemoryAccess } from '../../src/server/memory-access.js';
import { StorageClient } from '../../src/server/storage/storage-client.js';
import { SQLiteConversations } from '../../src/server/storage/sqlite-conversations.js';
export async function memoryRepositories(
  adapter: 'postgres' | 'sqlite',
  entry?: URL,
) {
  const owner = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'dots-memory-adapter-'));
  const database = join(root, 'workspace.sqlite');
  if (adapter === 'sqlite') {
    const client = await StorageClient.open({
      database,
      ownerId: owner,
      entry,
    });
    const conversations = new SQLiteConversations(client);
    return {
      owner,
      root,
      database,
      client,
      store: client.repositories.store,
      workspace: client.repositories.workspace,
      conversations,
      evidence: client.repositories.evidence,
      jobs: client.repositories.jobs,
      recall: client.repositories.recall,
      close: async () => {
        await conversations.close();
        await client.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  }
  const connection = process.env.LOCAL_TEST_DATABASE_URL!;
  const name = 'dots_memory_adapter_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: connection });
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(connection);
  url.pathname = '/' + name;
  const pg = new Pool({ connectionString: url.href });
  const store = new Store(database);
  const workspace = new WorkspaceStore(database, owner);
  const conversations = new PostgresConversations(url.href, owner);
  await conversations.initialize();
  const evidence = new ConversationMemory(
    pg,
    owner,
    workspace,
    () => store.settings().memoryAllowed,
  );
  const recall = new MemoryRecall(
    workspace.memory,
    evidence,
    new MemoryAccess(workspace, store),
  );
  const jobs = new MemoryJobs(pg, owner, Date.now, {
    publication: new DreamPublication(recall),
  });
  return {
    owner,
    root,
    database,
    store,
    workspace,
    conversations,
    evidence,
    jobs,
    recall,
    close: async () => {
      await conversations.close();
      await pg.end();
      workspace.close();
      store.close();
      // Pool.end() can resolve before PostgreSQL observes the final socket close.
      // Normal DROP waits for those exits instead of killing a client still closing.
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    },
  };
}
