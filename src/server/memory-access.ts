import type { MemoryItem, EvidenceGuard } from '../shared/memory.js';
import type { Store } from './store.js';
import type { WorkspaceStore } from './workspace.js';
import { evidenceHash, type SourceRecord } from './conversation-memory.js';
export interface RecallPrincipal {
  ownerId: string;
  dotId: string;
  spaceIds: string[];
  permissionGeneration: string;
}
export class MemoryAccess {
  constructor(
    readonly workspace: WorkspaceStore,
    readonly store: Store,
  ) {}
  forDot(dotId: string): RecallPrincipal {
    const dot = this.workspace.dot(dotId);
    if (!dot || !dot.memoryAllowed || !this.store.settings().memoryAllowed)
      throw new Error('Memory access is disabled');
    const spaceIds = [...dot.spaceIds].sort();
    return {
      ownerId: this.workspace.ownerId,
      dotId,
      spaceIds,
      permissionGeneration: evidenceHash([
        dotId,
        spaceIds,
        dot.memoryAllowed,
        this.store.settings().memoryAllowed,
      ]),
    };
  }
  guardAllowed(principal: RecallPrincipal, guard: EvidenceGuard): boolean {
    try {
      return (
        guard.spaceIds.every((id) =>
          this.workspace.canAccessSpace(principal.dotId, id),
        ) &&
        guard.pageIds.every((id) =>
          guard.spaceIds.some((spaceId) =>
            this.workspace.pages.exists(spaceId, id),
          ),
        )
      );
    } catch {
      return false;
    }
  }
  canRead(
    principal: RecallPrincipal,
    item: MemoryItem | SourceRecord,
  ): boolean {
    const current = this.forDot(principal.dotId);
    if (
      item.ownerId !== current.ownerId ||
      principal.ownerId !== current.ownerId
    )
      return false;
    if ('source' in item)
      return (
        item.guard.originDotId === current.dotId &&
        this.guardAllowed(current, item.guard)
      );
    if (
      item.status !== 'active' ||
      (item.expiresAt !== null && item.expiresAt <= Date.now())
    )
      return false;
    const scope = item.scope;
    if (scope.kind === 'dot' && scope.id !== current.dotId) return false;
    if (scope.kind === 'space' && !current.spaceIds.includes(scope.id))
      return false;
    return item.sources.every((ref) => this.guardAllowed(current, ref.guard));
  }
}
