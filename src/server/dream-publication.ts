import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  dreamChangeInputSchema,
  type AppliedChange,
  type ApplyReceipt,
  type DreamChange,
  type DreamProposal,
  type MemoryItem,
  type MemoryPatch,
  type MemoryScope,
  type PublicationPolicy,
  type RestorePreview,
} from '../shared/memory.js';
import type { MemoryRecall } from './memory-recall.js';
import { explicitPreference, hasWorkflowSupport } from './dream-analysis.js';
export class DreamPublication {
  constructor(readonly recall: MemoryRecall) {}
  private get memory() {
    return this.recall.memory;
  }
  private target(id: string, revision: number): MemoryItem {
    const item = this.memory.get(id);
    if (!item || item.revision !== revision)
      throw new Error('Memory revision conflict');
    return item;
  }
  private targets(
    change: DreamChange,
  ): Array<{ targetId: string; expectedRevision: number }> {
    return 'targetId' in change
      ? [change, ...(change.kind === 'merge' ? change.duplicates : [])]
      : [];
  }
  private async validate(change: DreamChange, dotId: string): Promise<boolean> {
    const { sources, explicitUser, ...raw } = change;
    void explicitUser;
    dreamChangeInputSchema.parse(raw);
    if (!sources.length || sources.length !== change.sourceIds.length)
      throw new Error('Missing proposal source evidence');
    const principal = this.recall.access.forDot(dotId);
    const records = await Promise.all(
      sources.map((ref) => this.recall.episodes.readSource(ref)),
    );
    for (let i = 0; i < records.length; i++)
      if (
        !records[i] ||
        records[i]!.id !== change.sourceIds[i] ||
        !this.recall.access.canRead(principal, records[i]!)
      )
        throw new Error('Proposal source evidence access unavailable');
    const valid = records.filter((r) => r !== undefined);
    if (change.kind === 'skill-candidate' && !hasWorkflowSupport(valid))
      throw new Error('A procedure needs two supported episodes');
    for (const target of this.targets(change)) {
      const item = this.target(target.targetId, target.expectedRevision);
      if (!this.recall.access.canRead(principal, item))
        throw new Error('Target memory access unavailable');
    }
    if (
      change.retention === 'temporary' &&
      (change.expiresAt === null || change.expiresAt <= Date.now())
    )
      throw new Error('Temporary memory requires a future expiry');
    return (
      change.support === 'explicit_user' &&
      valid.some((source) => explicitPreference(source, change.text))
    );
  }
  async apply(
    jobId: string,
    proposal: DreamProposal,
    policy: PublicationPolicy,
    dotId: string,
  ): Promise<ApplyReceipt> {
    const existing = this.memory.history.receipt(jobId);
    if (existing) return existing;
    if (proposal.changes.length > 20) throw new Error('Too many Dream changes');
    const supported = await Promise.all(
      proposal.changes.map((change) => this.validate(change, dotId)),
    );
    return this.memory.atomic(() => {
      const retry = this.memory.history.receipt(jobId);
      if (retry) return retry;
      const changes: AppliedChange[] = [];
      for (const [index, change] of proposal.changes.entries()) {
        this.recall.access.forDot(dotId);
        if (
          change.sources.some(
            (source) =>
              this.memory.sourceSuppressed(source) ||
              !this.recall.access.guardAllowed(
                this.recall.access.forDot(dotId),
                source.guard,
              ),
          )
        )
          throw new Error('Proposal source evidence was suppressed or revoked');
        const targets = this.targets(change).map((target) =>
          this.target(target.targetId, target.expectedRevision),
        );
        const automatic =
          policy === 'hybrid' &&
          supported[index] &&
          change.kind !== 'skill-candidate' &&
          targets.every(
            (item) =>
              item.scope.kind === 'dot' &&
              item.scope.id === dotId &&
              !item.pinned,
          );
        if (automatic)
          for (const before of targets) {
            const after = this.memory.edit(before.id, before.revision, {
              status: 'superseded',
              pinned: false,
            });
            changes.push({ before, after });
          }
        const after = this.memory.create({
          scope: { kind: 'dot', id: dotId },
          kind: change.kind === 'skill-candidate' ? 'skill' : 'fact',
          status: automatic ? 'active' : 'pending',
          title: change.title,
          text: change.text,
          sources: change.sources,
          expiresAt: change.expiresAt,
          supersedesId: targets[0]?.id ?? null,
          pinned: false,
        });
        if (!automatic) this.memory.history.saveOperation(after.id, change);
        changes.push({ before: null, after });
      }
      const receipt = {
        id: randomUUID(),
        jobId,
        dotId,
        createdAt: Date.now(),
        changes,
      };
      this.memory.history.saveReceipt(receipt);
      return receipt;
    });
  }
  async review(
    id: string,
    expectedRevision: number,
    decision: 'approve' | 'reject',
  ): Promise<MemoryItem> {
    const item = this.target(id, expectedRevision);
    if (item.status !== 'pending')
      throw new Error('Memory is not awaiting review');
    const operation = this.memory.history.operation(id);
    const dotId =
      item.scope.kind === 'dot'
        ? item.scope.id
        : item.sources[0]?.guard.originDotId;
    if (decision === 'approve' && operation && dotId)
      await this.validate(operation, dotId);
    return this.memory.atomic(() => {
      const before = this.target(id, expectedRevision),
        changes: AppliedChange[] = [];
      let pinned = false;
      if (decision === 'approve' && operation)
        for (const target of this.targets(operation)) {
          const old = this.target(target.targetId, target.expectedRevision);
          pinned ||= old.pinned;
          changes.push({
            before: old,
            after: this.memory.edit(old.id, old.revision, {
              status: 'superseded',
              pinned: false,
            }),
          });
        }
      if (decision === 'reject')
        this.memory.history.suppress(before.sources, 'Rejected proposal');
      const after = this.memory.edit(id, expectedRevision, {
        status: decision === 'approve' ? 'active' : 'rejected',
        pinned,
      });
      changes.push({ before, after });
      this.memory.history.saveReceipt({
        id: randomUUID(),
        jobId: 'review:' + randomUUID(),
        dotId: dotId ?? '',
        createdAt: Date.now(),
        changes,
      });
      return after;
    });
  }
  forget(id: string, expectedRevision: number): void {
    this.memory.atomic(() => {
      const before = this.target(id, expectedRevision);
      this.memory.history.suppress(before.sources, 'Forgotten memory');
      const after = this.memory.edit(id, expectedRevision, {
        status: 'forgotten',
        pinned: false,
      });
      this.memory.history.saveReceipt({
        id: randomUUID(),
        jobId: 'forget:' + randomUUID(),
        dotId: before.scope.kind === 'dot' ? before.scope.id : '',
        createdAt: Date.now(),
        changes: [{ before, after }],
      });
    });
  }
  async share(
    id: string,
    expectedRevision: number,
    scope: MemoryScope,
  ): Promise<MemoryItem> {
    const item = this.target(id, expectedRevision);
    if (scope.kind === 'dot' && !this.recall.access.workspace.dot(scope.id))
      throw new Error('Unknown Dot');
    if (
      scope.kind === 'space' &&
      !this.recall.access.workspace.spaces().some((s) => s.id === scope.id)
    )
      throw new Error('Unknown Space');
    for (const ref of item.sources)
      if (
        !(await this.recall.episodes.readSource(ref)) ||
        this.memory.sourceSuppressed(ref)
      )
        throw new Error('Source evidence unavailable');
    return this.memory.atomic(() => {
      this.target(id, expectedRevision);
      const changed = this.memory.edit(id, expectedRevision, { scope });
      this.memory.history.grant(changed, scope);
      return changed;
    });
  }
  previewRestore(changeSetId: string): RestorePreview {
    const receipt = this.memory.history.receipt(changeSetId);
    if (!receipt) throw new Error('Memory change set not found');
    const expectedRevisions: Record<string, number> = {},
      conflicts: string[] = [];
    for (const change of receipt.changes) {
      expectedRevisions[change.after.id] = change.after.revision;
      if (this.memory.get(change.after.id)?.revision !== change.after.revision)
        conflicts.push(change.after.id);
    }
    const preview = {
      id: randomUUID(),
      changeSetId: receipt.id,
      expectedRevisions,
      conflicts,
      changes: receipt.changes,
      expiresAt: Date.now() + 600000,
    };
    this.memory.history.savePreview(preview);
    return preview;
  }
  restore(
    previewId: string,
    expectedRevisions: Record<string, number>,
  ): ApplyReceipt {
    const retry = this.memory.history.receipt('restore:' + previewId);
    if (retry) return retry;
    const preview = this.memory.history.preview(previewId);
    if (!preview || preview.expiresAt < Date.now())
      throw new Error('Restore preview expired or unavailable');
    if (
      preview.conflicts.length ||
      !isDeepStrictEqual(expectedRevisions, preview.expectedRevisions)
    )
      throw new Error('Restore revision conflict');
    return this.memory.atomic(() => {
      const changes: AppliedChange[] = [];
      for (const change of [...preview.changes].reverse()) {
        const before = this.target(
          change.after.id,
          expectedRevisions[change.after.id],
        );
        const oldSources = new Set(
          change.before?.sources.map((s) => JSON.stringify(s)) ?? [],
        );
        this.memory.history.suppress(
          change.after.sources.filter(
            (s) => !oldSources.has(JSON.stringify(s)),
          ),
          'Restored change set',
        );
        const old = change.before;
        const patch: MemoryPatch = old
          ? {
              scope: old.scope,
              kind: old.kind,
              status: old.status,
              title: old.title,
              text: old.text,
              pinned: old.pinned,
              sources: old.sources,
              expiresAt: old.expiresAt,
              supersedesId: old.supersedesId,
            }
          : { status: 'forgotten', pinned: false };
        changes.push({
          before,
          after: this.memory.edit(before.id, before.revision, patch),
        });
      }
      const original = this.memory.history.receipt(preview.changeSetId)!;
      const receipt = {
        id: randomUUID(),
        jobId: 'restore:' + previewId,
        dotId: original.dotId,
        createdAt: Date.now(),
        changes,
      };
      this.memory.history.saveReceipt(receipt);
      return receipt;
    });
  }
}
