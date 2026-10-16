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
it('restores forget and reject suppression without clearing an independent forget', async () => {
  const f = await setup();
  const item = (
    await f.publication.apply('restore-forget', f.proposal, 'hybrid', f.dot.id)
  ).changes[0].after;
  f.publication.forget(item.id, 1);
  const forgot = f.workspace.memory.history.receipts()[0];
  const preview = f.publication.previewRestore(forgot.id);
  f.publication.restore(preview.id, preview.expectedRevisions);
  expect((await f.recall.read(f.dot.id, item.id)).text).toBe(item.text);
  const pending = (
    await f.publication.apply(
      'restore-reject',
      f.proposal,
      'review_all',
      f.dot.id,
    )
  ).changes[0].after;
  await f.publication.review(pending.id, 1, 'reject');
  const rejected = f.publication.previewRestore(
    f.workspace.memory.history.receipts()[0].id,
  );
  f.publication.restore(rejected.id, rejected.expectedRevisions);
  expect((await f.publication.review(pending.id, 3, 'approve')).status).toBe(
    'active',
  );
  f.publication.forget(item.id, 3);
  f.publication.forget(pending.id, 4);
  const second = f.publication.previewRestore(
    f.workspace.memory.history.receipts()[0].id,
  );
  f.publication.restore(second.id, second.expectedRevisions);
  await expect(f.recall.read(f.dot.id, pending.id)).rejects.toThrow(/access/);
});
it('restores a pending correction and its edited text with usable predecessor revisions', async () => {
  const f = await setup();
  const old = (
    await f.publication.apply('old-review', f.proposal, 'hybrid', f.dot.id)
  ).changes[0].after;
  const source = f.add('I prefer weekly reports.', 'correction').record;
  const change: DreamChange = {
    ...f.change,
    kind: 'supersede',
    targetId: old.id,
    expectedRevision: 1,
    text: source.text,
    sources: [source.source],
    sourceIds: [source.id],
  };
  const item = (
    await f.publication.apply(
      'pending-correction',
      { changes: [change], evidence: change.sources },
      'review_all',
      f.dot.id,
    )
  ).changes[0].after;
  f.workspace.memory.edit(item.id, 1, {
    text: 'Owner edited weekly preference',
  });
  await f.publication.review(item.id, 2, 'approve');
  const preview = f.publication.previewRestore(
    f.workspace.memory.history.receipts()[0].id,
  );
  f.publication.restore(preview.id, preview.expectedRevisions);
  expect(f.workspace.memory.get(item.id)?.text).toBe(
    'Owner edited weekly preference',
  );
  expect((await f.publication.review(item.id, 4, 'approve')).status).toBe(
    'active',
  );
});
it('shares selected source evidence directly to another Dot', async () => {
  const f = await setup(),
    other = f.workspace.createDot(f.dot.spaceId, 'Other', 'Help', true, true);
  const item = (
    await f.publication.apply('dot-share', f.proposal, 'hybrid', f.dot.id)
  ).changes[0].after;
  const privateSource = f.add('Private unrelated', 'private').record;
  await f.publication.share(item.id, 1, { kind: 'dot', id: other.id });
  expect(
    (await f.recall.readSource(other.id, f.change.sourceIds[0])).text,
  ).toBe(item.text);
  await expect(f.recall.readSource(other.id, privateSource.id)).rejects.toThrow(
    /access/,
  );
});
it('keeps a preference quoted inside a partial message awaiting review', async () => {
  const f = await setup();
  const record = f.records.get(f.change.sourceIds[0])!;
  record.source.start = 4000;
  record.source.end = 4000 + record.text.length;
  const item = (
    await f.publication.apply('partial', f.proposal, 'hybrid', f.dot.id)
  ).changes[0].after;
  expect(item.status).toBe('pending');
});
it('withholds forgotten tool arguments even when assistant content is empty', async () => {
  const f = await setup();
  const { evidenceHash } = await import('../src/server/conversation-memory.js');
  const message = {
    id: 'call',
    role: 'assistant' as const,
    content: '',
    toolCalls: [
      {
        id: 'tc',
        type: 'function' as const,
        function: {
          name: 'read_memory',
          arguments: '{"secret":"original value"}',
        },
      },
    ],
  };
  f.workspace.memory.history.suppress(
    [
      {
        threadId: 'thread',
        runId: 'run',
        messageIds: ['call'],
        contentHash: evidenceHash(message),
        guard: { originDotId: f.dot.id, spaceIds: [], pageIds: [] },
      },
    ],
    'forgot',
  );
  const visible = f.workspace.memory.maskMessages('thread', [message]);
  expect(JSON.stringify(visible)).not.toContain('original value');
  expect(visible[0].id).toBe('call');
});
