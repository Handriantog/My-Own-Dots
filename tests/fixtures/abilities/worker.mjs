import { createInterface } from 'node:readline';
import process from 'node:process';
import { setTimeout, setInterval } from 'node:timers';
import { appendFileSync, readFileSync } from 'node:fs';
const replies = new Map();
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const capability = (id, params) =>
  new Promise((resolve) => {
    replies.set(id, resolve);
    send({ id, method: 'capability', params });
  });
createInterface({ input: process.stdin }).on('line', async (line) => {
  const input = JSON.parse(line);
  if (replies.has(input.id)) {
    replies.get(input.id)(input.result);
    replies.delete(input.id);
    return;
  }
  if (input.method === 'initialize') {
    send({ id: input.id, result: { apiVersion: 1 } });
    return;
  }
  if (input.method !== 'invoke') return;
  appendFileSync('pids', `${process.pid}\n`);
  const args = input.params.arguments;
  if (input.params.tool === 'parser') {
    await new Promise((resolve) => setTimeout(resolve, args.delay));
    if (args.delay === 100)
      await capability('after-parent-result', {
        kind: 'account',
        accountId: 'account',
      });
    send({ id: input.id, result: { status: 'success', value: process.pid } });
    return;
  }
  if (args.op === 'hold' || args.op === 'ignore-term') {
    if (args.op === 'ignore-term') process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    appendFileSync('ready', 'ready\n');
    return;
  }
  if (args.op === 'malformed') {
    process.stdout.write('{bad\n');
    return;
  }
  if (args.op === 'oversize') {
    process.stdout.write('x'.repeat(1024 * 1024 + 1));
    return;
  }
  if (args.op === 'unknown') {
    send({ id: 'untrusted', method: 'escape', params: {} });
    return;
  }
  if (args.op === 'helpers') {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        capability(`helper${index}`, {
          kind: 'helper',
          helperId: 'parser',
          arguments: { delay: 400 },
        }),
      ),
    );
    send({ id: input.id, result: { status: 'success', value: results } });
    return;
  }
  if (args.op === 'background-helper') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    void capability('background', {
      kind: 'helper',
      helperId: 'parser',
      arguments: { delay: 100 },
    });
    while (readFileSync('pids', 'utf8').trim().split('\n').length < 2)
      await new Promise((resolve) => setTimeout(resolve, 5));
    send({ id: input.id, result: { status: 'success' } });
    return;
  }
  if (args.op === 'late-helper') {
    await capability('wait', { kind: 'account', accountId: 'account' });
    const result = await capability('late', {
      kind: 'helper',
      helperId: 'parser',
      arguments: { delay: 0 },
    });
    send({ id: input.id, result: { status: 'success', value: result } });
    return;
  }
  let readBlocked = false;
  try {
    readFileSync(args.outside);
  } catch {
    readBlocked = true;
  }
  send({
    id: input.id,
    result: {
      status: 'success',
      value: {
        pid: process.pid,
        readBlocked,
        injected: process.env.ABILITY_FIXTURE_SECRET ?? null,
      },
    },
  });
});
