import { installErrorLogging, logError } from '../../shared/error-log.js';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serveStorage } from './storage-worker.js';
import { storageFailure } from './repository-contract.js';
if (!parentPort)
  throw new Error('Storage worker requires a private message port');
if (process.env.DOTS_ERROR_LOG_DIR)
  installErrorLogging(process.env.DOTS_ERROR_LOG_DIR, 'storage');
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
  logError('storage_start_failed', error, { worker: 'storage' });
  database?.close();
  parentPort.postMessage({ kind: 'fatal', error: storageFailure(error) });
  parentPort.close();
}
