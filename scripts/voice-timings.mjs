import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const labels = {
  endDetectionMs: 'Detect end of speech (server observed)',
  recognitionQueueMs: 'Recognition queue / stopping previous response',
  recognitionMs: 'Speech recognition (including recovery)',
  transcriptToRunMs: 'Transcript delivery / client submission',
  runnerWaitMs: 'Conversation runner / storage wait',
  agentSetupMs: 'Agent setup',
  firstContextMs: 'First context preparation',
  firstSchedulerWaitMs: 'First inference scheduler wait',
  providerToFirstTextMs:
    'Provider to first validated text (includes tool rounds)',
  textPersistenceMs: 'First text persistence',
  speechQueueMs: 'Saved text to synthesis (includes buffered answer wait)',
  recoveryWaitMs: 'Remaining speech recovery wait (part of saved-text wait)',
  firstSynthesisMs: 'First speech chunk generation',
  audioDispatchMs: 'First audio dispatch',
  playbackAckMs: 'Audio dispatch to software playback acknowledgement',
};
const phaseLabels = {
  lockWaitMs: 'Internal lock wait',
  preparationMs: 'Provider preparation',
  accountReadMs: 'Account check (within preparation)',
  requirementsReadMs: 'Requirements check (within preparation)',
  configReadMs: 'Configuration check (within preparation)',
  threadConfigReadMs: 'Thread configuration check (within preparation)',
  threadCreateMs: 'Thread creation (within preparation)',
  turnStartAckMs: 'Turn-start acknowledgement (from dispatch)',
  firstDeltaMs: 'First raw answer delta (from dispatch)',
  firstValidatedTextMs: 'First validated text (from dispatch)',
  turnCompletedMs: 'Provider completion observed (from dispatch)',
  textCallbackMs: 'Text callback/acknowledgement wait (overlaps)',
  cleanupMs: 'Provider context cleanup',
  totalMs: 'Total Python decision',
};
const seconds = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${(value / 1000).toFixed(3)} s`
    : 'unknown';
// IDs and stages originate on the server; sanitize anyway when reading arbitrary files.
const safe = (value) =>
  String(value ?? '')
    .replace(/[^a-zA-Z0-9_:.TZ-]/g, '')
    .slice(0, 80);
const recognitionReason = (value) =>
  [
    'invalid_timestamp',
    'invalid_segment_text',
    'segment_limit',
    'text_limit',
    'unknown',
  ].includes(value)
    ? value
    : 'unknown';

try {
  const { values } = parseArgs({
    options: {
      file: {
        type: 'string',
        default: 'artifacts/voice-session-workspace.log',
      },
      last: { type: 'string', default: '5' },
    },
  });
  const limit = Number(values.last);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw Error('--last must be between 1 and 100');
  const turns = new Map();
  const lines = createInterface({
    input: createReadStream(values.file),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.startsWith('[voice-timing] ') || line.length > 10000) continue;
    let row;
    try {
      row = JSON.parse(line.slice('[voice-timing] '.length));
    } catch {
      continue;
    }
    if (
      row?.version !== 1 ||
      typeof row.callId !== 'string' ||
      typeof row.messageId !== 'string'
    )
      continue;
    const key = `${row.callId}:${row.messageId}`;
    if (!turns.has(key)) {
      // Late cancellation/completion must not resurrect an evicted older turn.
      // Read a complete server log: a truncated prefix without a start is ignored.
      if (row.event !== 'stage' || row.stage !== 'speech_end_detected')
        continue;
      turns.set(key, []);
      if (turns.size > limit) turns.delete(turns.keys().next().value);
    }
    const rows = turns.get(key);
    if (rows.length < 256) rows.push(row);
  }
  if (!turns.size)
    console.log(
      'No voice timing traces yet. Enable LOCAL_VOICE_TIMING_LOG=1, restart the workspace, then start a new Talk call.',
    );
  for (const rows of turns.values()) {
    const first = rows[0];
    const summary = rows.find((row) => row.event === 'first_playback');
    console.log(
      `\n${safe(first.at)}  call ${safe(first.callId)}  turn ${safe(first.messageId)}`,
    );
    if (summary) {
      console.log(
        `Observed wait to first playback acknowledgement: ${seconds(summary.elapsedMs)}`,
      );
      for (const [key, label] of Object.entries(labels))
        if (Object.hasOwn(summary.durations ?? {}, key))
          console.log(`  ${label}: ${seconds(summary.durations[key])}`);
    } else
      console.log(
        'No playback acknowledgement recorded (pending, muted, interrupted, approval or failed).',
      );
    for (const row of rows.filter(
      (row) => row.event === 'recognition_result',
    )) {
      const outcome = [
        'decoded',
        'empty',
        'rejected',
        'superseded',
        'engine_failed',
        'pipeline_failed',
      ].includes(row.outcome)
        ? row.outcome
        : 'unknown';
      console.log(
        `  Recognition: ${outcome}, audio=${seconds(row.audioMs)}${row.reason ? `, reason=${recognitionReason(row.reason)}` : ''}${row.fallbackReason ? `, retry after ${recognitionReason(row.fallbackReason)}` : ''}`,
      );
    }
    for (const row of rows.filter((row) => row.event === 'provider_result')) {
      const t = row.timings ?? {};
      console.log(
        `  Provider step ${safe(row.step)}: startup=${seconds(t.startupMs)}, first text=${seconds(t.firstTextMs)}, total=${seconds(t.totalMs)}, reused=${typeof t.reusedProvider === 'boolean' ? t.reusedProvider : 'unknown'}, delivery=${safe(t.delivery) || 'unknown'}`,
      );
      const p = t.phases;
      if (p && typeof p === 'object') {
        for (const [key, label] of Object.entries(phaseLabels))
          if (Object.hasOwn(p, key))
            console.log(
              `    ${label}: ${p[key] === null ? 'not observed' : seconds(p[key])}`,
            );
        if (
          typeof p.firstDeltaMs === 'number' &&
          typeof p.firstValidatedTextMs === 'number'
        )
          console.log(
            `    Raw delta to validated text: ${seconds(p.firstValidatedTextMs - p.firstDeltaMs)}`,
          );
      }
    }
    console.log('  Timeline (elapsed from last server-observed voiced frame):');
    for (const row of rows.filter((row) => row.event === 'stage'))
      console.log(
        `    ${seconds(row.elapsedMs).padStart(10)}  ${safe(row.stage)}${row.step ? ` [step ${safe(row.step)}]` : ''}`,
      );
  }
  if (turns.size)
    console.log(
      '\nProvider completion overlaps speech; do not add it to first-playback latency. Playback acknowledgements do not measure physical audible onset.',
    );
} catch (error) {
  console.error(`Cannot read voice timings: ${error.message}`);
  process.exitCode = 1;
}
