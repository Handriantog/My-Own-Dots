import type { z } from 'zod';
import { Store } from '../store.js';
import { WorkspaceStore } from '../workspace.js';
import type { pageInput, pagePatch } from '../pages.js';
import type {
  StoreRepository,
  WorkspaceRepository,
} from './runtime-repositories.js';
interface PageScope {
  dotId: string;
  threadId: string;
  spaceId?: string;
  defaultSpaceId?: string;
}
/** Permission checks and the dependent database operation share one worker request/transaction. */
export class RuntimePolicy {
  constructor(
    private store: Store,
    private workspace: WorkspaceStore,
  ) {}
  turnState(dotId: string, sourcePages: Array<[string, string[]]> = []) {
    if (
      sourcePages.length > 1000 ||
      sourcePages.some(([, spaces]) => spaces.length > 100)
    )
      throw new Error('Too many page dependencies');
    return {
      settings: this.store.settings(),
      dot: this.workspace.dot(dotId),
      memoryGeneration: this.workspace.memory.generation(),
      connections: this.workspace.connections.fingerprint(dotId),
      abilities: this.workspace.abilities.fingerprint(dotId),
      sourcesAvailable: sourcePages.every(([id, spaces]) =>
        spaces.some((space) => this.workspace.pages.exists(space, id)),
      ),
    };
  }
  private scope(input: PageScope) {
    const thread = this.workspace.requireThread(input.threadId, input.dotId);
    if (this.store.settings().paused) throw new Error('Workspace is paused');
    const dot = this.workspace.dot(thread.dotId);
    if (!dot) throw new Error('Dot not found');
    const space =
      input.spaceId ??
      this.workspace.pages.forThread(input.threadId)?.spaceId ??
      input.defaultSpaceId ??
      dot.spaceId;
    if (!this.workspace.canAccessSpace(dot.id, space))
      throw new Error('Space access has been revoked or was not granted.');
    return space;
  }
  pageContext(input: PageScope) {
    return this.workspace.pages.forThread(input.threadId, this.scope(input));
  }
  pageSpaces(input: PageScope) {
    this.scope(input);
    return this.workspace
      .spaces()
      .filter((space) => this.workspace.canAccessSpace(input.dotId, space.id));
  }
  listPages(input: PageScope) {
    return this.workspace.pages.list(this.scope(input));
  }
  readPage(input: PageScope, id: string) {
    return this.workspace.pages.get(this.scope(input), id);
  }
  create(input: PageScope, value: z.input<typeof pageInput>) {
    return this.workspace.pages.create(this.scope(input), value);
  }
  editPage(input: PageScope, id: string, value: z.input<typeof pagePatch>) {
    return this.workspace.pages.update(this.scope(input), id, value);
  }
}
export function runtimePolicy(
  store: StoreRepository,
  workspace: WorkspaceRepository,
) {
  if ('policy' in workspace) return workspace.policy;
  if (!(store instanceof Store) || !(workspace instanceof WorkspaceStore))
    throw new Error('Worker policy is required');
  return new RuntimePolicy(store, workspace);
}
