// Independent author fixture: public JSON-RPC only; no host/SDK imports.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') reply(message.id, { apiVersion: 1 });
  if (message.method === 'invoke') {
    writeFileSync('verified', 'node');
    reply(message.id, { status: 'success', value: 42 });
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
