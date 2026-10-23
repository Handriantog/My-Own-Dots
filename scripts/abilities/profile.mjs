// Acceptance harness adapter: exercise the exact application profile generator.
import { readFileSync } from 'node:fs';
import { buildSandboxProfile } from '../../src/desktop/host/abilities/sandbox.ts';
const inputs = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(inputs.map(buildSandboxProfile)));
