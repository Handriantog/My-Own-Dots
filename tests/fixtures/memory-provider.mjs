/* global process */
// Offline fixture for the real Integrator subprocess. No network or account.
import { readFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
if (!prompt.includes('"purpose":"dream"'))
  throw new Error('Missing Dream evidence');
process.stdout.write(
  JSON.stringify({
    kind: 'proposal',
    changes: [],
    noChangeReason: 'Fixture: no durable changes',
  }) + '\n',
);
