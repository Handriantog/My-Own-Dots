import { afterEach, expect, it } from 'vitest';
import { DreamPublication } from '../src/server/dream-publication.js';
import type { DreamChange, DreamProposal } from '../src/shared/memory.js';
import { publicationFixture } from './fixtures/memory.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
async function setup() {
  const f = await publicationFixture();
  cleanup.push(f.close);
  const { record } = f.add('I prefer concise reports.');
  const change: DreamChange = {
    kind: 'create',
    title: 'Report style',
    text: record.text,
    sourceIds: [record.id],
    sources: [record.source],
    support: 'explicit_user',
    explicitUser: true,
    justification: 'Direct preference',
    retention: 'stable',
    expiresAt: null,
  };
  return {
    ...f,
    publication: new DreamPublication(f.recall),
    change,
    proposal: {
      changes: [change],
      evidence: [record.source],
    } satisfies DreamProposal,
  };
}
it('commits a validated batch and receipt once, with atomic rollback on invalid records', async () => {
  const f = await setup();
  const invalid = {
    ...f.change,
    text: 'x'.repeat(2001),
    support: 'inferred' as const,
  };
  await expect(
    f.publication.apply(
      'invalid',
      { ...f.proposal, changes: [f.change, invalid] },
      'hybrid',
      f.dot.id,
    ),
  ).rejects.toThrow();
  expect(f.workspace.memory.listOwner({}).items).toEqual([]);
  const receipt = await f.publication.apply(
    'job',
    f.proposal,
    'hybrid',
    f.dot.id,
  );
  expect(
    (await f.publication.apply('job', f.proposal, 'hybrid', f.dot.id)).id,
  ).toBe(receipt.id);
  expect(f.workspace.memory.listOwner({}).items).toHaveLength(1);
  expect(receipt.changes[0].after).toMatchObject({
    status: 'active',
    pinned: false,
    scope: { kind: 'dot', id: f.dot.id },
  });
});
it('supersedes corrected facts while protecting concurrent manual edits', async () => {
  const f = await setup();
  const old = (await f.publication.apply('old', f.proposal, 'hybrid', f.dot.id))
    .changes[0].after;
  const { record } = f.add('Correction: I prefer detailed reports.', 'correct');
  const correction: DreamChange = {
    ...f.change,
    kind: 'supersede',
    targetId: old.id,
    expectedRevision: 1,
    text: record.text,
    sourceIds: [record.id],
    sources: [record.source],
  };
  const proposal = { changes: [correction], evidence: [record.source] };
  const receipt = await f.publication.apply(
    'correct',
    proposal,
    'hybrid',
    f.dot.id,
  );
  expect(f.workspace.memory.get(old.id)?.status).toBe('superseded');
  const current = receipt.changes.find((c) => c.before === null)!.after;
  f.workspace.memory.edit(current.id, current.revision, {
    text: 'Manual edit wins',
  });
  await expect(
    f.publication.apply(
      'stale',
      {
        changes: [{ ...correction, targetId: current.id }],
        evidence: [record.source],
      },
      'hybrid',
      f.dot.id,
    ),
  ).rejects.toThrow(/revision/);
});
it('requires review for procedures and makes restoration a new revision with conflict checks', async () => {
  const f = await setup();
  const first = f.add('That worked; use this workflow again.', 'one').record,
    second = f.add('Approved; that worked.', 'two').record;
  const workflow: DreamChange = {
    ...f.change,
    kind: 'skill-candidate',
    text: 'Read requirements, draft, review.',
    support: 'inferred',
    explicitUser: false,
    sourceIds: [first.id, second.id],
    sources: [first.source, second.source],
  };
  const receipt = await f.publication.apply(
    'skill',
    { changes: [workflow], evidence: workflow.sources },
    'hybrid',
    f.dot.id,
  );
  const item = receipt.changes[0].after;
  expect(item.status).toBe('pending');
  expect((await f.publication.review(item.id, 1, 'approve')).status).toBe(
    'active',
  );
  const pendingReceipt = await f.publication.apply(
    'review-all',
    f.proposal,
    'review_all',
    f.dot.id,
  );
  const pending = pendingReceipt.changes[0].after;
  const preview = f.publication.previewRestore(pendingReceipt.id);
  const restored = f.publication.restore(preview.id, preview.expectedRevisions);
  expect(f.workspace.memory.get(pending.id)).toMatchObject({
    status: 'forgotten',
    revision: 2,
  });
  expect(restored.id).not.toBe(pendingReceipt.id);
  const conflict = f.publication.previewRestore(receipt.id);
  expect(conflict.conflicts).toContain(item.id);
  expect(() =>
    f.publication.restore(conflict.id, conflict.expectedRevisions),
  ).toThrow(/revision/);
});
it('rechecks source existence and shares only selected evidence, never the thread', async () => {
  const f = await setup();
  const receipt = await f.publication.apply(
    'job',
    f.proposal,
    'hybrid',
    f.dot.id,
  );
  const item = receipt.changes[0].after;
  const other = f.workspace.createDot(
    f.dot.spaceId,
    'Other',
    'Help',
    true,
    true,
  );
  const privateSource = f.add(
    'Unrelated private conversation',
    'private',
  ).record;
  await f.publication.share(item.id, 1, { kind: 'owner' });
  expect(
    (await f.recall.readSource(other.id, f.change.sourceIds[0])).text,
  ).toContain('concise');
  await expect(f.recall.readSource(other.id, privateSource.id)).rejects.toThrow(
    /access/,
  );
  f.records.clear();
  await expect(
    f.publication.apply('revoked', f.proposal, 'hybrid', f.dot.id),
  ).rejects.toThrow(/source|evidence/);
});

it('allows forgetting imported legacy text beyond the manual-write size cap', async () => {
  const f = await setup();
  f.workspace.memory.importLegacy([
    { id: 'legacy-long', text: 'x'.repeat(3000), createdAt: 1 },
  ]);
  f.publication.forget('legacy-long', 1);
  expect(f.workspace.memory.get('legacy-long')).toMatchObject({
    status: 'forgotten',
    revision: 2,
  });
});
