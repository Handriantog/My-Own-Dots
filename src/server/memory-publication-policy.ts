import type {
  MemoryJob,
  PublishDreamInput,
  JobPublicationContext,
} from './memory-jobs.js';
/** Shared policy for legacy publication and the worker's atomic unified publication. */
export function assertPublicationScope(
  job: MemoryJob,
  input: PublishDreamInput,
) {
  if (job.kind !== 'dream' || job.dotId !== input.dotId)
    throw new Error('Dream job Dot scope mismatch');
  if (job.publicationPolicy !== input.policy)
    throw new Error('Dream publication policy changed');
  const selected = new Set(job.sourceIds);
  if (
    input.proposal.changes.some((change) =>
      change.sourceIds.some((id) => !selected.has(id)),
    )
  )
    throw new Error('Proposal evidence is outside the job scope');
}
export function assertPublicationAllowed(
  job: MemoryJob,
  context: JobPublicationContext,
  now: number,
) {
  context.check?.(job);
  const { recall } = context.publication;
  if (recall.access.store.settings().paused)
    throw new Error('Maintenance paused');
  recall.access.forDot(job.dotId);
  const settings = recall.access.workspace.memory.settings(job.dotId, now);
  if (
    job.origin === 'automatic' &&
    (!settings.learningEnabled || !settings.autoDream)
  )
    throw new Error('Maintenance disabled');
}
