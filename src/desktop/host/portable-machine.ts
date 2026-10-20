import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Keep this identifier in the machine's normal profile, outside the portable root. */
export function portableMachineBinding(
  machineProfile: string,
  portableRoot: string,
) {
  mkdirSync(machineProfile, { recursive: true, mode: 0o700 });
  const path = join(machineProfile, 'portable-machine-id');
  let id: string;
  try {
    const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      id = readFileSync(file, 'utf8');
    } finally {
      closeSync(file);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    id = randomUUID();
    const file = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(file, id);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
  }
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new Error('Portable machine identity is invalid');
  return createHash('sha256')
    .update(JSON.stringify([id, process.platform, realpathSync(portableRoot)]))
    .digest('hex');
}
