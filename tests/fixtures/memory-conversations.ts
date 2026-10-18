import {
  replayRun,
  type ConversationSnapshot,
  type LocalConversationStore,
  type ThreadLease,
} from '../../src/server/local-conversations.js';
export class MemoryStore implements LocalConversationStore {
  ownerId = 'owner';
  snapshot: ConversationSnapshot = { messages: [], state: {} };
  locked = false;
  failure?: 'begin' | 'append' | 'read' | 'finish';
  ids = new Set<string>();
  async getOrCreateThread() {
    return {
      id: 'thread',
      agentId: 'dot',
      organizationId: 'local',
      createdById: 'owner',
      name: null,
      archived: false,
      createdAt: '',
      updatedAt: '',
    };
  }
  async getSnapshot() {
    if (this.failure === 'read') throw new Error('offline');
    const copy = structuredClone(this.snapshot);
    return copy.lastRun
      ? {
          ...copy,
          ...(await replayRun(copy.lastRun.input, copy.lastRun.events)),
        }
      : copy;
  }
  async isRunning() {
    return this.locked;
  }
  async acquireThread(): Promise<ThreadLease | null> {
    if (this.locked) return null;
    this.locked = true;
    return {
      signal: new AbortController().signal,
      read: () => this.getSnapshot(),
      beginRun: async (input) => {
        if (this.failure === 'begin') throw new Error('offline');
        if (this.ids.has(input.runId)) throw new Error('Run already used');
        this.ids.add(input.runId);
        this.snapshot = {
          messages: structuredClone(input.messages),
          state: structuredClone(input.state),
          lastRun: {
            input: structuredClone(input),
            runId: input.runId,
            events: [],
            status: 'running',
          },
        };
      },
      appendEvent: async (event) => {
        if (this.failure === 'append') throw new Error('offline');
        this.snapshot.lastRun!.events.push(structuredClone(event));
      },
      finishRun: async (messages, state, status, terminal) => {
        if (this.failure === 'finish') throw new Error('offline');
        if (terminal)
          this.snapshot.lastRun!.events.push(structuredClone(terminal));
        this.snapshot.messages = structuredClone(messages);
        this.snapshot.state = structuredClone(state);
        this.snapshot.lastRun!.status = status;
      },
      release: async () => {
        this.locked = false;
      },
    };
  }
}
