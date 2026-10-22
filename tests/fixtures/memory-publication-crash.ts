import { readFile } from 'node:fs/promises';
import { StorageClient } from '../../src/server/storage/storage-client.js';
const [database, owner, requestFile, mode] = process.argv.slice(2);
const client = await StorageClient.open({
  database,
  ownerId: owner,
  ...(mode === 'before-ack'
    ? { entry: new URL('./repository-worker-probe.ts', import.meta.url) }
    : {}),
});
const request = JSON.parse(await readFile(requestFile, 'utf8'));
// Separate process/worker startup from the short in-transaction barrier wait.
if (mode === 'before-ack') process.send?.('publishing');
await client.repositories.jobs.publishDream(request);
process.send?.('committed');
setInterval(() => undefined, 1000);
