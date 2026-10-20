// Real worker/database with an instrumented SQLite trigger. The barrier exists only in this test fixture.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { serveStorage } from '../../src/server/storage/storage-worker.js';
const db = new DatabaseSync(workerData.database);
await serveStorage(parentPort!, db, workerData.ownerId);
db.function('probe_write', () => {
  writeFileSync(workerData.database + '.started', 'started');
  const deadline = Date.now() + 3000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(workerData.database + '.continue')) {
    if (Date.now() > deadline) throw new Error('Test write barrier timed out');
    Atomics.wait(wait, 0, 0, 5);
  }
  return 1;
});
db.exec(
  'CREATE TEMP TRIGGER probe_write BEFORE INSERT ON memories BEGIN SELECT probe_write(); END;',
);
db.exec(
  "CREATE TEMP TRIGGER probe_event BEFORE INSERT ON conversation_events WHEN NEW.type='TEXT_MESSAGE_CONTENT' BEGIN SELECT probe_write(); END;",
);
db.exec(
  'CREATE TEMP TRIGGER probe_publication BEFORE INSERT ON memory_processed_sources BEGIN SELECT probe_write(); END;',
);
const crash = setInterval(() => {
  if (existsSync(workerData.database + '.crash')) process.exit(37);
}, 5);
crash.unref();
