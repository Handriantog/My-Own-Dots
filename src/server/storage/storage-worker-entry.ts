import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serveStorage } from './storage-worker.js';
import { storageFailure } from './repository-contract.js';
if (!parentPort)
  throw new Error('Storage worker requires a private message port');
let database: DatabaseSync | undefined;
try {
  if (
    typeof workerData.database !== 'string' ||
    typeof workerData.ownerId !== 'string' ||
    !workerData.ownerId
  )
    throw new Error('Invalid storage initialization');
  if (workerData.database !== ':memory:')
    mkdirSync(dirname(workerData.database), { recursive: true });
  database = new DatabaseSync(workerData.database);
  await serveStorage(parentPort, database, workerData.ownerId, workerData);
} catch (error) {
  database?.close();
  parentPort.postMessage({ kind: 'fatal', error: storageFailure(error) });
  parentPort.close();
}
