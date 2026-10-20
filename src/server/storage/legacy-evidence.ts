import { ConversationMemory } from '../conversation-memory.js';
/** The legacy indexer already owns its PostgreSQL transaction; the worker exposes the same bounded-run protocol. */
export class LegacyEvidence extends ConversationMemory {
  async indexBatch(runId: string) {
    await this.indexRun(runId);
    return { complete: true };
  }
}
export interface StorageOptions {
  engine?: 'legacy-postgres' | 'sqlite';
  postgresUrl?: string;
  pinnedTokenLimit?: number;
}
