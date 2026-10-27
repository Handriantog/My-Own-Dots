import {
  voiceDelegationActive,
  type VoiceDelegation,
} from '../../shared/voice-delegation';
import type { VoiceTaskState } from './VoiceTasks';
const labels: Record<VoiceDelegation['status'], string> = {
  queued: 'Queued',
  running: 'Working',
  approval: 'Needs approval',
  completed: 'Finished',
  cancelled: 'Stopped',
  failed: 'Failed',
  interrupted: 'Interrupted',
};
export function VoiceTaskList({ jobs, error, stopping, stop }: VoiceTaskState) {
  if (!jobs.length) return null;
  return (
    <section className="voice-tasks" aria-label="Voice tasks">
      {jobs.map((job) => (
        <div className="voice-task" key={job.id}>
          <div>
            <strong>{labels[job.status]}</strong>
            <p>{job.request}</p>
            <a
              href={`#/chat/${encodeURIComponent(job.dotId)}/${encodeURIComponent(job.workerThreadId)}`}
            >
              {job.status === 'approval'
                ? 'Review approval'
                : 'Open task conversation'}
            </a>
          </div>
          {voiceDelegationActive(job.status) && (
            <button
              type="button"
              disabled={stopping === job.id}
              onClick={() => stop(job.id)}
            >
              Stop task
            </button>
          )}
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
