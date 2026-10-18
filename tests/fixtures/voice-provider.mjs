// Offline wrapper around the existing application provider fixture. Arguments
// are test-owned paths; stdin/stdout keep the actual Integrator protocol.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

const [mode, observations, suffixGate, exitGate] = process.argv.slice(2);
if (!['valid', 'invalid', 'cancel'].includes(mode) || !exitGate)
  throw new Error('Expected fixture mode and control paths.');
const fixture = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('./subscription-provider.mjs', import.meta.url))],
  { input: readFileSync(0), encoding: 'utf8', timeout: 5000 },
);
if (fixture.status !== 0)
  throw new Error('Application provider fixture failed.');
const result = JSON.parse(fixture.stdout);
if (mode === 'invalid') result.text = 42;
const wire = JSON.stringify(result) + '\n';
const record = (event) =>
  appendFileSync(
    observations,
    JSON.stringify({ event, pid: process.pid }) + '\n',
  );
async function waitForGate(path) {
  const deadline = performance.now() + 10000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline)
      throw new Error('Fixture gate timed out.');
    await setTimeout(10);
  }
}
await new Promise((resolve) =>
  process.stdout.write(wire.slice(0, 11), resolve),
);
record('fragment-written');
await waitForGate(suffixGate);
await new Promise((resolve) => process.stdout.write(wire.slice(11), resolve));
record('complete-written');
await waitForGate(exitGate);
